#!/usr/bin/env bash
# K-04's "done when": kafka-console-consumer, with each generated client-*.properties,
# reads the topic "demo" off the compose stand.
#
#   go run ./cmd/testpki -out testdata/pki
#   docker compose -f testdata/compose.yaml up -d      # wait for the seed service to finish
#   testdata/verify.sh
#
# The consumer runs in the broker's own image on the host network, so "localhost" is
# what the certificates were issued for and what the broker advertises. Run it on the
# machine the stand runs on, and with the stand's default KAFKA_HOST.
#
# The properties name their stores relative to the working directory, which is why the
# container starts in the pki directory. The container's user (uid 1000) must be able to
# read those files; testpki writes them 0600, so on a host whose user is not 1000 run
# `chmod -R a+rX testdata/pki` first — they are test keys.
set -u
cd "$(dirname "$0")"

IMAGE=${KAFKA_IMAGE:-apache/kafka:3.9.0}
HOST=${BOOTSTRAP_HOST:-localhost}

# properties file             port  (the listener it belongs to)
cases=(
  "client-plaintext.properties       19092"
  "client-ssl-p12.properties         19093"
  "client-ssl-jks.properties         19093"
  "client-ssl-pem.properties         19093"
  "client-sasl-plaintext.properties  19094"
  "client-sasl-ssl.properties        19095"
)

failed=0
for c in "${cases[@]}"; do
  read -r props port <<<"$c"
  out=$(docker run --rm --network host -v "$PWD/pki:/pki:ro" -w /pki "$IMAGE" \
    /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server "$HOST:$port" --consumer.config "$props" \
    --topic demo --from-beginning --max-messages 3 --timeout-ms 20000 --property print.key=true 2>&1)
  n=$(grep -c -E '^k[123][[:space:]]' <<<"$out")
  if [ "$n" -eq 3 ]; then
    printf 'ok    %-34s %s:%s  3 messages\n' "$props" "$HOST" "$port"
  else
    printf 'FAIL  %-34s %s:%s  read %s of 3\n' "$props" "$HOST" "$port" "$n"
    tail -5 <<<"$out" | sed 's/^/        /'
    failed=1
  fi
done
exit $failed
