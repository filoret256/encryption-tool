module enc-tool/kafka-agent

go 1.26.0

require (
	enc-tool/agent-kit v0.0.0
	github.com/bufbuild/protocompile v0.14.1
	github.com/iskorotkov/avro/v2 v2.34.0
	github.com/pavlo-v-chernykh/keystore-go/v4 v4.5.0
	github.com/twmb/franz-go v1.22.1
	github.com/twmb/franz-go/pkg/kadm v1.19.0
	github.com/twmb/franz-go/pkg/kfake v0.0.0-20260927204940-b5a45ccfdf7e
	github.com/twmb/franz-go/pkg/kmsg v1.14.0
	github.com/twmb/franz-go/pkg/sr v1.8.0
	go.yaml.in/yaml/v3 v3.0.5
	google.golang.org/protobuf v1.36.8
	software.sslmate.com/src/go-pkcs12 v0.7.3
)

require (
	github.com/go-viper/mapstructure/v2 v2.4.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/klauspost/compress v1.20.0 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/pierrec/lz4/v4 v4.1.30 // indirect
	golang.org/x/crypto v0.51.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
)

replace enc-tool/agent-kit => ../agent-kit-go
