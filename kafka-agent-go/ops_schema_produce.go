// Sending a message that carries a schema (K-45): the page writes JSON, and this side
// serializes it in the schema's own format — Avro binary, a Protobuf message, or JSON —
// behind the Confluent header, so the value on the topic is what any other client of that
// registry expects to find.
//
// The serialization happens here, not in the page: the registry is reachable from this side
// (it holds the credentials), the schema cache is here, and a value that does not fit has to
// be refused *before* anything is written to the topic. A produce that succeeded with bytes
// no reader can decode is worse than a produce that failed.
package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"

	"github.com/iskorotkov/avro/v2"
	"github.com/twmb/franz-go/pkg/sr"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/dynamicpb"
)

// avroFromJSON is the Avro codec a *sent* value is written with. It is the library's own
// configuration; what JSON forces on a value is done by fitNumbers before the codec sees it.
var avroFromJSON = avro.Config{}.Freeze()

// fitNumbers makes a value that came from JSON into one the Avro writer takes.
//
// The JSON is read with UseNumber, so a number arrives as the text it was typed with
// (json.Number), not as a float64. A float64 holds a whole number exactly only up to 2^53:
// a long above it (an epoch in nanoseconds, a 64-bit id) would be rounded before it was
// written, and the topic would hold a value nobody sent. Here the text is read by the width
// the schema names — int, long, float or double — and a number that is not a whole number
// of that width is an error with the field's path in front of it, which is what the page
// shows. Nothing is rounded.
//
// The schema is walked beside the value, so a number inside a union is resolved too: the
// writer finds a union branch by the Go type of the value, and a float64 never named the
// branch "long". The first numeric branch the number fits is the one that is written.
func fitNumbers(s avro.Schema, v any, path string) (any, error) {
	if ref, ok := s.(*avro.RefSchema); ok {
		s = ref.Schema()
	}
	switch value := v.(type) {
	case json.Number:
		switch s.Type() {
		case avro.Int, avro.Long, avro.Float, avro.Double:
			out, err := numberFor(s.Type(), value)
			return out, withPath(path, err)
		case avro.Union:
			var firstErr error
			for _, branch := range s.(*avro.UnionSchema).Types() {
				switch branch.Type() {
				case avro.Int, avro.Long, avro.Float, avro.Double:
					out, err := numberFor(branch.Type(), value)
					if err == nil {
						return out, nil
					}
					if firstErr == nil {
						firstErr = err
					}
				}
			}
			if firstErr != nil {
				return nil, withPath(path, firstErr)
			}
			return nil, withPath(path, fmt.Errorf("%s: the union has no numeric type", value))
		}
		return value, nil
	case map[string]any:
		switch schema := s.(type) {
		case *avro.RecordSchema:
			out := make(map[string]any, len(value))
			for k, item := range value {
				out[k] = item
			}
			for _, f := range schema.Fields() {
				item, ok := value[f.Name()]
				if !ok {
					continue
				}
				fitted, err := fitNumbers(f.Type(), item, joinPath(path, f.Name()))
				if err != nil {
					return nil, err
				}
				out[f.Name()] = fitted
			}
			return out, nil
		case *avro.MapSchema:
			out := make(map[string]any, len(value))
			for k, item := range value {
				fitted, err := fitNumbers(schema.Values(), item, joinPath(path, k))
				if err != nil {
					return nil, err
				}
				out[k] = fitted
			}
			return out, nil
		case *avro.UnionSchema:
			for _, branch := range schema.Types() {
				if t := branch.Type(); t == avro.Record || t == avro.Map || t == avro.Ref {
					return fitNumbers(branch, v, path)
				}
			}
		}
	case []any:
		switch schema := s.(type) {
		case *avro.ArraySchema:
			out := make([]any, len(value))
			for i, item := range value {
				fitted, err := fitNumbers(schema.Items(), item, fmt.Sprintf("%s[%d]", path, i))
				if err != nil {
					return nil, err
				}
				out[i] = fitted
			}
			return out, nil
		case *avro.UnionSchema:
			for _, branch := range schema.Types() {
				if branch.Type() == avro.Array {
					return fitNumbers(branch, v, path)
				}
			}
		}
	}
	return v, nil
}

func joinPath(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func withPath(path string, err error) error {
	if err == nil || path == "" {
		return err
	}
	return fmt.Errorf("%s: %w", path, err)
}

// numberFor reads a JSON number as the Go type the writer takes for an Avro type.
func numberFor(t avro.Type, n json.Number) (any, error) {
	switch t {
	case avro.Int:
		i, err := wholeNumber(n, 32)
		if err != nil {
			return nil, err
		}
		return int(i), nil
	case avro.Long:
		return wholeNumber(n, 64)
	case avro.Float:
		f, err := strconv.ParseFloat(n.String(), 32)
		if err != nil && !isRange(err) {
			return nil, fmt.Errorf("%s is not a number", n)
		}
		return float32(f), nil
	default:
		f, err := strconv.ParseFloat(n.String(), 64)
		if err != nil && !isRange(err) {
			return nil, fmt.Errorf("%s is not a number", n)
		}
		return f, nil
	}
}

// isRange tells "too large for the type" from "not a number": ParseFloat hands back ±Inf
// with a range error for the first, and a float that cannot be written is refused later.
func isRange(err error) bool {
	var ne *strconv.NumError
	return errors.As(err, &ne) && ne.Err == strconv.ErrRange
}

// wholeNumber reads a JSON number as an integer of the given width. "7", "-7", "7.0" and
// "1e3" are whole numbers; "1.5" and a number outside the width are not, and the message
// says which.
func wholeNumber(n json.Number, bits int) (int64, error) {
	text := n.String()
	if i, err := strconv.ParseInt(text, 10, bits); err == nil {
		return i, nil
	}
	// A whole number written with a fraction or an exponent ("7.0", "1e3"): read it
	// exactly, as a decimal, so a value above 2^53 is never rounded on the way.
	// A number with an absurd length or exponent is refused before the exact reader sees
	// it: "1e999999999" must cost a message, not memory.
	if len(text) > 100 {
		return 0, fmt.Errorf("%.20s… is not a %d-bit whole number", text, bits)
	}
	if f, err := strconv.ParseFloat(text, 64); (err == nil || isRange(err)) && math.Abs(f) > 1e19 {
		return 0, fmt.Errorf("%s is not a %d-bit whole number", text, bits)
	}
	r, ok := new(big.Rat).SetString(text)
	if !ok {
		return 0, fmt.Errorf("%s is not a number", text)
	}
	if !r.IsInt() {
		return 0, fmt.Errorf("%s is not a whole number", text)
	}
	if !r.Num().IsInt64() {
		return 0, fmt.Errorf("%s is not a %d-bit whole number", text, bits)
	}
	i := r.Num().Int64()
	if bits == 32 && (i < math.MinInt32 || i > math.MaxInt32) {
		return 0, fmt.Errorf("%s is not a 32-bit whole number", text)
	}
	return i, nil
}

// serializeForSchema turns one JSON text into the bytes the schema describes, with the
// Confluent header in front of them, and hands them back base64 — the shape the rest of the
// produce path already knows how to turn into a record. The schema is read by subject and
// version, the pair a person picks in the send dialog, and its id goes into the header.
func serializeForSchema(c *opCtx, clusterName string, ref produceSchema, what string, text *string, encoding string) (string, error) {
	if text == nil {
		return "", &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is missing, and a schema was named for it", what)}
	}
	// The page sends JSON text; anything else would be serialized twice.
	switch encoding {
	case "", "text", "json":
	default:
		return "", &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is written as %q, but a value written with a schema is JSON", what, encoding)}
	}
	if ref.Subject == "" {
		return "", &opError{Code: "EPARAM", Message: fmt.Sprintf("No subject for the %s's schema", what)}
	}
	if ref.Version == 0 || ref.Version < -1 {
		return "", &opError{Code: "EPARAM", Message: "A version number, 1 or more, or -1 for the latest"}
	}
	cl, client, ctx, cancel, err := registryFor(c, clusterName)
	if err != nil {
		return "", err
	}
	defer cancel()
	info, err := c.conn.schemaForVersion(ctx, client, ref.Subject, ref.Version)
	if err != nil {
		if coded, ok := err.(*opError); ok {
			return "", coded
		}
		return "", registryFailure(cl, fmt.Sprintf("read version %d of %q", ref.Version, ref.Subject), err)
	}
	// The same schema object the viewer decodes with, from the same cache: a value written
	// with a schema is read back with it, and both sides must mean the same thing.
	parsed, err := c.conn.parsedSchema(info, info.id)
	if err != nil {
		return "", err
	}
	body, err := encodeForSchema(parsed, what, *text)
	if err != nil {
		return "", err
	}
	raw := make([]byte, headerLen, headerLen+len(body))
	raw[0] = magicByte
	binary.BigEndian.PutUint32(raw[1:headerLen], uint32(info.id))
	raw = append(raw, body...)
	return base64.StdEncoding.EncodeToString(raw), nil
}

// schemaForVersion reads what a named subject and version hold: what a value written with
// a schema is written with.
//
// A concrete version is kept for the life of the connection — its text cannot change —
// so sending ten messages with "orders-value v3" is one registry read. The latest (-1)
// is never kept: registering a version moves it, and the point of asking for the latest
// is to get the latest at the moment of sending.
func (c *connection) schemaForVersion(ctx context.Context, client *sr.Client, subject string, version int) (schemaInfo, error) {
	cache := c.schemaCache()
	key := schemaVersionKey{subject: subject, version: version}
	if version >= 1 {
		cache.mu.Lock()
		info, ok := cache.byVersion[key]
		cache.mu.Unlock()
		if ok {
			return info, nil
		}
	}
	s, err := client.SchemaByVersion(ctx, subject, version)
	if err != nil {
		return schemaInfo{}, err
	}
	schemaSubject, schemaVersion := s.Subject, s.Version
	info := schemaInfo{id: s.ID, typ: schemaTypeOf(s.Type), text: s.Schema.Schema, subject: &schemaSubject, version: &schemaVersion}
	if version >= 1 {
		cache.mu.Lock()
		cache.byVersion[key] = info
		cache.mu.Unlock()
	}
	return info, nil
}

// encodeForSchema is the three formats, each with its own way of reading JSON. Every failure
// says what did not fit, and names the field where the format's own reader does.
func encodeForSchema(parsed *cachedSchema, what, text string) ([]byte, error) {
	switch parsed.typ {
	case "AVRO":
		// UseNumber: a number stays the text it was typed with until the schema says
		// what width it is (see avroFromJSON), so a long above 2^53 is not rounded.
		var value any
		dec := json.NewDecoder(strings.NewReader(text))
		dec.UseNumber()
		if err := dec.Decode(&value); err != nil {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is not JSON: %v", what, err)}
		}
		// json.Unmarshal refused text after the value; a Decoder does not.
		if _, err := dec.Token(); err != io.EOF {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is not JSON: text after the value", what)}
		}
		value, err := fitNumbers(parsed.avro, value, "")
		if err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The %s does not fit the Avro schema: %v", what, err)}
		}
		body, err := avroFromJSON.Marshal(parsed.avro, value)
		if err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The %s does not fit the Avro schema: %v", what, err)}
		}
		return body, nil
	case "PROTOBUF":
		message := dynamicpb.NewMessage(parsed.proto)
		// protojson names the field it choked on and the line it was on, which is what the
		// page shows: a value that does not fit has to say where.
		if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal([]byte(text), message); err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The %s does not fit the Protobuf schema %s: %v", what, parsed.proto.FullName(), err)}
		}
		body, err := proto.Marshal(message)
		if err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The %s could not be written as Protobuf: %v", what, err)}
		}
		// The message indexes a reader needs. This side always writes the first message of
		// the file, and the writer's shorthand for that is a single zero.
		return append([]byte{0}, body...), nil
	case "JSON":
		if !json.Valid([]byte(text)) {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is not JSON, and this schema is a JSON Schema", what)}
		}
		return []byte(text), nil
	}
	return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("A schema of type %q cannot be written by this agent (Avro, Protobuf and JSON Schema it can)", parsed.typ)}
}
