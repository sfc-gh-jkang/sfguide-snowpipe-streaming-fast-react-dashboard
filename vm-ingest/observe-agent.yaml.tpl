# observe-agent.yaml — Observe Agent config for ACME ingest sidecar.
# Accepts OTLP traces from credit-ingest FastAPI at localhost:4318 and forwards
# to Observe collect endpoint.
#
# IMPORTANT: token and observe_url are literal values baked at deploy time.

token: "__OBSERVE_TOKEN__"
observe_url: "__OBSERVE_URL__"

forwarding:
  enabled: true
  traces:
    enabled: true
  metrics:
    enabled: false
  logs:
    enabled: true
  endpoints:
    grpc: 0.0.0.0:4317
    http: 0.0.0.0:4318

host_monitoring:
  enabled: false
self_monitoring:
  enabled: false

resource_attributes:
  service.name: credit-ingest
  deployment.environment.name: gcp-vm

otel_config_overrides:
  exporters:
    otlphttp/observe:
      headers:
        authorization: "Bearer __OBSERVE_DATASTREAM_TOKEN__"
  service:
    pipelines:
      metrics/forward:
        exporters: [debug]

debug: false
