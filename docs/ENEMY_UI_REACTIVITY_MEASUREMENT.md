# Enemy UI reactivity measurement

Phase 8.4 compares the mod's live subscription path with the former direct-store-read shape.

Command:

```text
node scripts/measure-enemy-reactivity.mjs 5000
```

Result from the production `enemyData.applyEnemyDamage` path:

```json
{
  "iterations": 5000,
  "subscription": { "ms": 36.945, "notifications": 5000, "checksum": 12502500 },
  "directStoreRead": { "ms": 21.703, "reads": 5000, "checksum": 12502500 },
  "polling": false
}
```

The subscription path is approximately 1.70x the direct-read control in this Node benchmark, while
observing every damage write. The combat tracker therefore uses `ctx.table.subscribe` and does not
add a polling interval.
