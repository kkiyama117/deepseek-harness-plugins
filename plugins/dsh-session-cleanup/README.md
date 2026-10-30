# Session connection cleanup

Listens to the official `session/disposed` event and calls pi-ai’s public `cleanupSessionResources(session.id)`. It never clears all Sessions or closes a cache after each turn. Cordis owns listener disposal. Socket closure is requested synchronously; peer closure is not awaited.

The imported pi-ai package is a peer so the Host adapter and this listener use the same module identity. Installation selects the Host row `local-session-cleanup`. No model calls, timers, stored records, or monkey patches are added.
