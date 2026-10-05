// devstand runs three fake Kafka clusters with data in them, in one process, and
// writes the kafka-agent config that points at them. For looking at the kafka
// tab without a broker: no Docker, no Java.
//
//	go run ./cmd/devstand -dir /tmp/stand
//	kafka-agent --config /tmp/stand/kafka-agent.yaml
//
// The clusters speak the real protocol (franz-go's kfake): "dev" is plaintext,
// "secure" wants a client certificate, "login" wants a SCRAM login.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/scram"

	"enc-tool/kafka-agent/internal/testpki"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "devstand:", err)
		os.Exit(1)
	}
}

func main() {
	dir := flag.String("dir", "devstand", "where to write the config and the certificates")
	live := flag.Bool("live", false, "keep writing to the events topic — for watching the live tail")
	flag.Parse()
	must(os.MkdirAll(*dir, 0o755))

	pki, err := testpki.New()
	must(err)
	must(pki.WriteFiles(*dir))

	dev, err := kfake.NewCluster(kfake.NumBrokers(3), kfake.ClusterID("dev-cluster"),
		kfake.SeedTopics(3, "orders"), kfake.SeedTopics(1, "app-logs", "blobs"), kfake.SeedTopics(2, "empty-topic"), kfake.SeedTopics(6, "events"))
	must(err)
	defer dev.Close()
	secure, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.ClusterID("secure-cluster"), kfake.SeedTopics(1, "hello"),
		kfake.TLS(pki.ServerTLS(tls.RequireAndVerifyClientCert)))
	must(err)
	defer secure.Close()
	login, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.ClusterID("login-cluster"), kfake.SeedTopics(1, "hello"),
		kfake.EnableSASL(), kfake.Superuser("SCRAM-SHA-512", "app", "app-secret"))
	must(err)
	defer login.Close()

	stop := seed(dev.ListenAddrs()[0])
	defer stop()
	if *live {
		go writeLive(dev.ListenAddrs()[0])
	}
	pool := x509.NewCertPool()
	pool.AddCert(pki.CA.Cert)
	seedSmall(secure.ListenAddrs()[0], kgo.DialTLSConfig(&tls.Config{
		RootCAs:      pool,
		Certificates: []tls.Certificate{{Certificate: [][]byte{pki.Client.Cert.Raw}, PrivateKey: pki.Client.Key}},
	}))
	seedSmall(login.ListenAddrs()[0], kgo.SASL(scram.Auth{User: "app", Pass: "app-secret"}.AsSha512Mechanism()))

	yaml := fmt.Sprintf(`# Written by cmd/devstand.
clusters:
  - name: dev
    bootstrap: %s
    properties: client-plaintext.properties
  - name: secure
    bootstrap: %s
    properties: client-ssl-p12.properties
  - name: login
    bootstrap: %s
    properties: client-sasl-plaintext.properties
    readOnly: true
`, dev.ListenAddrs()[0], secure.ListenAddrs()[0], login.ListenAddrs()[0])
	cfg := filepath.Join(*dir, "kafka-agent.yaml")
	must(os.WriteFile(cfg, []byte(yaml), 0o644)) // #nosec G306 -- a dev fixture with test keys

	fmt.Printf("three fake clusters are up (dev, secure, login); config: %s\nCtrl+C to stop\n", cfg)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	<-ctx.Done()
}

// seed fills the dev cluster: JSON orders across partitions, a long log, a topic
// with a very large message, an empty one, and two consumer groups — one with a
// live member that is behind, one that has left.
func seed(addr string) func() {
	prod, err := kgo.NewClient(kgo.SeedBrokers(addr), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.ProducerBatchMaxBytes(32<<20), kgo.MaxBufferedBytes(64<<20))
	must(err)
	defer prod.Close()
	ctx := context.Background()
	base := time.Now().Add(-6 * time.Hour)
	var recs []*kgo.Record
	statuses := []string{"created", "paid", "shipped", "delivered", "refunded"}
	for i := 0; i < 90; i++ {
		recs = append(recs, &kgo.Record{
			Topic: "orders", Partition: int32(i % 3), Key: []byte(fmt.Sprintf("order-%04d", i)),
			Value: []byte(fmt.Sprintf(`{"id":%d,"status":%q,"customer":"user-%d","total":%.2f,"items":[{"sku":"A-%d","qty":%d}]}`,
				i, statuses[i%len(statuses)], i%17, 10+float64(i)*1.37, i%9, 1+i%4)),
			Timestamp: base.Add(time.Duration(i) * 4 * time.Minute),
			Headers:   []kgo.RecordHeader{{Key: "source", Value: []byte("checkout")}, {Key: "trace-id", Value: []byte(fmt.Sprintf("%016x", i*7919))}},
		})
	}
	for i := 0; i < 400; i++ {
		level := []string{"INFO", "INFO", "INFO", "WARN", "ERROR"}[i%5]
		recs = append(recs, &kgo.Record{
			Topic: "app-logs", Value: []byte(fmt.Sprintf("2026-01-02T03:%02d:%02dZ %s service=api request=%d took=%dms", i/60%60, i%60, level, 1000+i, 5+i%97)),
			Timestamp: base.Add(time.Duration(i) * 30 * time.Second),
		})
	}
	recs = append(recs,
		&kgo.Record{Topic: "blobs", Key: []byte("small"), Value: []byte("hello")},
		&kgo.Record{Topic: "blobs", Key: []byte("large"), Value: []byte(strings.Repeat("0123456789abcdef", 1<<16))}, // 1 MiB
		&kgo.Record{Topic: "blobs", Key: []byte("binary"), Value: []byte{0x00, 0x01, 0xfe, 0xff, 0x80, 0x90}},
		&kgo.Record{Topic: "blobs", Key: []byte("gone"), Value: nil},
	)
	for _, r := range recs {
		if r.Topic == "app-logs" || r.Topic == "blobs" {
			r.Partition = 0
		}
	}
	fmt.Println("devstand: producing", len(recs), "messages")
	must(prod.ProduceSync(ctx, recs...).FirstErr())
	fmt.Println("devstand: produced")

	// A group that is behind and still alive.
	live, err := kgo.NewClient(kgo.SeedBrokers(addr), kgo.ConsumerGroup("billing"), kgo.ConsumeTopics("orders"),
		kgo.DisableAutoCommit(), kgo.ClientID("billing-worker-1"), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	must(err)
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	var read []*kgo.Record
	for len(read) < 90 && pctx.Err() == nil {
		live.PollFetches(pctx).EachRecord(func(r *kgo.Record) { read = append(read, r) })
	}
	cancel()
	fmt.Println("devstand: billing read", len(read))
	must(live.CommitRecords(ctx, read[:40]...))

	// One that has read the logs and gone away.
	gone, err := kgo.NewClient(kgo.SeedBrokers(addr), kgo.ConsumerGroup("log-shipper"), kgo.ConsumeTopics("app-logs"),
		kgo.DisableAutoCommit(), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	must(err)
	pctx, cancel = context.WithTimeout(ctx, 10*time.Second)
	read = nil
	for len(read) < 250 && pctx.Err() == nil {
		gone.PollFetches(pctx).EachRecord(func(r *kgo.Record) { read = append(read, r) })
	}
	cancel()
	must(gone.CommitRecords(ctx, read[:250]...))
	fmt.Println("devstand: log-shipper read", len(read))
	gone.Close()

	return live.Close
}

func seedSmall(addr string, opts ...kgo.Opt) {
	prod, err := kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers(addr)}, opts...)...)
	must(err)
	defer prod.Close()
	var recs []*kgo.Record
	for i := 0; i < 5; i++ {
		recs = append(recs, &kgo.Record{Topic: "hello", Value: []byte(fmt.Sprintf("message %d", i))})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	must(prod.ProduceSync(ctx, recs...).FirstErr())
}

// writeLive writes a message to the events topic every quarter of a second, and now
// and then a burst too fast for a page to show — the two things a live tail meets.
func writeLive(addr string) {
	prod, err := kgo.NewClient(kgo.SeedBrokers(addr))
	must(err)
	defer prod.Close()
	ctx := context.Background()
	for i := 0; ; i++ {
		time.Sleep(250 * time.Millisecond)
		n := 1
		if i%40 == 39 {
			n = 1500
		}
		recs := make([]*kgo.Record, 0, n)
		for k := 0; k < n; k++ {
			recs = append(recs, &kgo.Record{
				Topic: "events", Key: []byte(fmt.Sprintf("device-%d", (i+k)%9)),
				Value: []byte(fmt.Sprintf(`{"seq":%d,"level":%q,"msg":"heartbeat"}`, i*1500+k, []string{"info", "info", "warn"}[(i+k)%3])),
			})
		}
		_ = prod.ProduceSync(ctx, recs...).FirstErr()
	}
}
