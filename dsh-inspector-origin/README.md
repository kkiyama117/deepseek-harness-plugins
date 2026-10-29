# Inspector origin configuration

This deployment-only bundle adds the DSH site's existing HTTPS origin to the official Inspector `clientOrigins` setting. It preserves the shipped `captureFetch: true` value and the loopback-only bind and client-token authentication. It grants no wildcard origin and exposes no listener on the LAN.

The browser must still be on the Host or have an explicitly managed path to the loopback endpoint. This bundle does not turn the local Inspector into a remotely exposed debugging service. It removes the origin rejection when the Host's browser accesses DSH through its already trusted HTTPS address.

The patch replaces the entire `experimental-inspector` configuration; carry any additional deployment-specific fields into it before installation. The Inspector bundle itself must be selected separately.
