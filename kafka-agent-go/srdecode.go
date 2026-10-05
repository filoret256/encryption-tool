// Reading a message that carries a schema: the Confluent wire format.
//
//	byte 0      magic, always 0
//	bytes 1-4   the schema's id at the registry, big-endian
//	then        the payload of that schema's own format:
//	              AVRO       the Avro binary encoding of the value
//	              PROTOBUF   the message indexes, then the wire-format message
//	              JSON       the value as JSON text
//
// The page decides *whether* to ask — a value whose first byte is not 0 is not one of these
// — and this side decides what the bytes mean: it is the side that can reach the registry,
// and the side with the schema cache.
//
// A decoded value is JSON, whatever the schema was: that is what the viewer shows, and it
// is the one shape every one of the three formats can be written in.
package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"

	"github.com/bufbuild/protocompile"
	"github.com/iskorotkov/avro/v2"
	"github.com/twmb/franz-go/pkg/sr"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// magicByte starts every schema-encoded value; the id follows it in four bytes.
const magicByte = 0
const headerLen = 5

// ── the schema cache ──────────────────────────────────────────────────────

// A schema, read once from the registry and kept in the shape the decoder needs: an Avro
// schema is parsed once, a .proto is compiled once, and neither is re-read for every
// message. Keyed by the schema id, which is what the wire format carries — and which the
// registry never reuses for different text.
type cachedSchema struct {
	avro   avro.Schema
	proto  protoreflect.MessageDescriptor
	typ    string
	failed error // remembered: a schema that will not parse will not parse next time either
}

type schemaCache struct {
	mu      sync.Mutex
	byID    map[int]*cachedSchema
	fetched map[int]schemaInfo
	// What a named subject and version hold, for a value about to be written (K-45): a
	// version's text never changes, so asking once is enough. The latest (-1) is never
	// kept — registering a version moves it, and that is K-47's whole point.
	byVersion map[schemaVersionKey]schemaInfo
}

// schemaVersionKey is one version of one subject, as a person picks it in the send dialog.
type schemaVersionKey struct {
	subject string
	version int
}

type schemaInfo struct {
	// The id the registry gave this schema. Kept here as well as passed around by the
	// decode path, because a write needs it for the header (K-45).
	id      int
	typ     string
	text    string
	subject *string
	version *int
}

func (c *connection) schemaCache() *schemaCache {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.schemas == nil {
		c.schemas = &schemaCache{byID: map[int]*cachedSchema{}, fetched: map[int]schemaInfo{}, byVersion: map[schemaVersionKey]schemaInfo{}}
	}
	return c.schemas
}

// ── messages.decode ───────────────────────────────────────────────────────

// decodeValue turns one schema-encoded value into JSON, with what the registry says the
// schema is: its id, its type, and where it is registered.
//
// Nothing here guesses. A value that does not start with the magic byte is refused with a
// sentence that says so — the page asks only when it thinks it has one, but a wrong guess
// deserves an answer rather than an error from a decoder.
func decodeValue(c *opCtx, p decodeValueParams) (any, error) {
	cl, err := c.srv.cluster(p.Cluster)
	if err != nil {
		return nil, err
	}
	if cl.Registry == nil {
		return nil, &opError{Code: "ENOREGISTRY", Message: fmt.Sprintf(
			"Cluster %q has no Schema Registry in the agent's configuration, so a schema-encoded value cannot be read. Add schemaRegistry to it in kafka-agent.yaml.", cl.Name)}
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(p.Value))
	if err != nil {
		return nil, &opError{Code: "EPARAM", Message: "The value is not base64: " + err.Error()}
	}
	if len(raw) < headerLen || raw[0] != magicByte {
		return nil, &opError{Code: "EPARAM", Message: "This value does not carry a schema: it does not start with the magic byte and a schema id"}
	}
	id := int(binary.BigEndian.Uint32(raw[1:headerLen]))
	payload := raw[headerLen:]

	ctx, cancel := context.WithTimeout(c.ctx, registryTimeout)
	defer cancel()
	client, err := c.conn.registryClient(cl)
	if err != nil {
		return nil, err
	}
	info, err := c.conn.schemaFor(ctx, client, c.conn.schemaCache(), id)
	if err != nil {
		return nil, err
	}
	schema, err := c.conn.parsedSchema(info, id)
	if err != nil {
		return nil, err
	}

	out := decodedValue{SchemaID: id, SchemaType: info.typ, Subject: info.subject, Version: info.version}
	switch info.typ {
	case "AVRO":
		var v any
		if err := avro.Unmarshal(schema.avro, payload, &v); err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value is not the Avro the schema describes (schema id %d): %v", id, err)}
		}
		text, err := avroJSON(schema.avro, v)
		if err != nil {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The Avro value could not be written as JSON (schema id %d): %v", id, err)}
		}
		out.JSON = string(text)
	case "PROTOBUF":
		text, name, err := decodeProto(schema.proto, payload)
		if err != nil {
			return nil, err
		}
		out.JSON = text
		if name != "" {
			out.Message = &name
		}
	case "JSON":
		if !json.Valid(payload) {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value is not the JSON the schema describes (schema id %d)", id)}
		}
		out.JSON = string(payload)
	default:
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("Schema id %d is of type %q, which this agent cannot read (Avro, Protobuf and JSON Schema it can)", id, info.typ)}
	}
	return out, nil
}

// schemaFor reads what the registry knows about one id: its type and text, and — when the
// registry can say — the subject and version it is registered under. Kept for the life of
// the connection: an id names one schema for good.
func (c *connection) schemaFor(ctx context.Context, client *sr.Client, cache *schemaCache, id int) (schemaInfo, error) {
	cache.mu.Lock()
	if info, ok := cache.fetched[id]; ok {
		cache.mu.Unlock()
		return info, nil
	}
	cache.mu.Unlock()

	schema, err := client.SchemaByID(ctx, id)
	if err != nil {
		_, message := registryProblem(err)
		return schemaInfo{}, &opError{Code: "EKAFKA", Message: fmt.Sprintf("Schema id %d is not in the registry: %s", id, message)}
	}
	typ := schema.Type.String()
	if typ == "" {
		typ = "AVRO" // the registry leaves it out for Avro, which was the first format
	}
	info := schemaInfo{id: id, typ: typ, text: schema.Schema}
	// Where it is registered: nice to show, and not worth failing over.
	if versions, verr := client.SchemaVersionsByID(ctx, id); verr == nil && len(versions) > 0 {
		subject, version := versions[0].Subject, versions[0].Version
		info.subject, info.version = &subject, &version
	}
	cache.mu.Lock()
	cache.fetched[id] = info
	cache.mu.Unlock()
	return info, nil
}

// parsedSchema is the schema in the shape its decoder wants, made once per id.
//
// Keyed by the id alone: an id names one schema for good — the registry never hands the same
// id to different text — and a cache belongs to one connection, which is one cluster and one
// registry.
func (c *connection) parsedSchema(info schemaInfo, id int) (*cachedSchema, error) {
	cache := c.schemaCache()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if parsed, ok := cache.byID[id]; ok {
		return parsed, parsed.failed
	}
	parsed := &cachedSchema{typ: info.typ}
	switch info.typ {
	case "AVRO":
		sch, err := avro.Parse(info.text)
		if err != nil {
			parsed.failed = &opError{Code: "EKAFKA", Message: fmt.Sprintf("The registry's Avro schema will not parse: %v", err)}
		} else {
			parsed.avro = sch
		}
	case "PROTOBUF":
		desc, err := compileProto(info.text)
		if err != nil {
			parsed.failed = err
		} else {
			parsed.proto = desc
		}
	case "JSON":
		if !json.Valid([]byte(info.text)) {
			parsed.failed = &opError{Code: "EKAFKA", Message: "The registry's JSON Schema is not JSON"}
		}
	}
	cache.byID[id] = parsed
	return parsed, parsed.failed
}

// ── Protobuf ──────────────────────────────────────────────────────────────

// compileProto turns the registry's .proto text into the first message of the file. The
// standard imports resolve from the compiler's own well-known types, so a schema that
// imports google/protobuf/timestamp.proto works without the file being present.
func compileProto(text string) (protoreflect.MessageDescriptor, error) {
	source := &protocompile.SourceResolver{
		Accessor: protocompile.SourceAccessorFromMap(map[string]string{"schema.proto": text}),
	}
	compiler := protocompile.Compiler{Resolver: protocompile.WithStandardImports(source)}
	files, err := compiler.Compile(context.Background(), "schema.proto")
	if err != nil {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The registry's Protobuf schema will not compile: %v", err)}
	}
	messages := files[0].Messages()
	if messages.Len() == 0 {
		return nil, &opError{Code: "EKAFKA", Message: "The registry's Protobuf schema declares no message"}
	}
	return messages.Get(0), nil
}

// protoIndexes reads the message indexes that Confluent's serializer writes between the
// header and the message: a varint count, then that many varints. A count of 0 is the
// writer's shorthand for "the first message of the file".
//
// Both numbers come off the topic, so both are bounded before they are used: a count of
// 2^63 would otherwise be an allocation, and an index of 2^63 a conversion nothing good
// comes of. A path deeper than a handful of nested messages is not a path anyone made.
func protoIndexes(payload []byte) ([]int, []byte, error) {
	const maxIndexes = 64
	bad := func() error {
		return &opError{Code: "EKAFKA", Message: "The value does not carry the Protobuf message indexes"}
	}
	count, n := binary.Uvarint(payload)
	if n <= 0 {
		return nil, nil, bad()
	}
	payload = payload[n:]
	if count == 0 {
		return []int{0}, payload, nil
	}
	if count > maxIndexes {
		return nil, nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value names %d Protobuf message indexes; no schema is that deep", count)}
	}
	indexes := make([]int, 0, count)
	for range count {
		v, n := binary.Uvarint(payload)
		if n <= 0 {
			return nil, nil, bad()
		}
		if v > math.MaxInt32 {
			return nil, nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value names Protobuf message index %d; no schema has that many", v)}
		}
		payload = payload[n:]
		indexes = append(indexes, int(v))
	}
	return indexes, payload, nil
}

// protoMessage walks the indexes: the first picks a message of the file, each of the rest
// picks a field of the message before it — the path Confluent's own deserializer follows.
func protoMessage(first protoreflect.MessageDescriptor, indexes []int) (protoreflect.MessageDescriptor, error) {
	file := first.ParentFile()
	if indexes[0] >= file.Messages().Len() {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value names message %d of the schema, which has %d", indexes[0], file.Messages().Len())}
	}
	message := file.Messages().Get(indexes[0])
	for _, i := range indexes[1:] {
		if i >= message.Fields().Len() {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value names field %d of %s, which has %d", i, message.FullName(), message.Fields().Len())}
		}
		field := message.Fields().Get(i)
		if field.Kind() != protoreflect.MessageKind && field.Kind() != protoreflect.GroupKind {
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value names field %d of %s, which is not a message", i, message.FullName())}
		}
		message = field.Message()
	}
	return message, nil
}

// decodeProto reads one Protobuf value into JSON, and names the message it held: a .proto
// file may declare several, and the indexes say which.
func decodeProto(first protoreflect.MessageDescriptor, payload []byte) (string, string, error) {
	indexes, body, err := protoIndexes(payload)
	if err != nil {
		return "", "", err
	}
	desc, err := protoMessage(first, indexes)
	if err != nil {
		return "", "", err
	}
	message := dynamicpb.NewMessage(desc)
	if err := proto.Unmarshal(body, message); err != nil {
		return "", "", &opError{Code: "EKAFKA", Message: fmt.Sprintf("The value is not the Protobuf message %s describes: %v", desc.FullName(), err)}
	}
	// A JSON name for every field, and the enum names rather than their numbers: what a
	// person reading the message expects to see.
	text, err := protojson.MarshalOptions{UseEnumNumbers: false}.Marshal(message)
	if err != nil {
		return "", "", &opError{Code: "EKAFKA", Message: fmt.Sprintf("The Protobuf message %s could not be written as JSON: %v", desc.FullName(), err)}
	}
	return string(text), string(desc.FullName()), nil
}
