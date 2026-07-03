# ServeLocal Documentation

- [Architecture](./architecture.md) — system diagram, components, request lifecycle
- [Security & controls matrix](./security.md) — every control mapped to its implementation
- [Architecture Decision Records](./adr/README.md)
- [Privacy & PII inventory](./privacy.md)
- [Data retention policy](./data-retention.md)
- [Regulatory compliance (GDPR / HIPAA)](./compliance.md)
- [Disaster recovery (RTO/RPO + runbook)](./disaster-recovery.md)

Operational entry points:
- Run: `node server.js` · Tests: `npm test` · Coverage gate: `npm run coverage:check`
- Load: `npm run loadtest` · Chaos: `npm run chaos` · Backup/restore: `npm run backup` / `node scripts/restore.js --force`
- Deployment & Stripe cutover: `../DEPLOY.txt`
- Contributing & review standard: `../CONTRIBUTING.md` · Vulnerability reporting: `../SECURITY.md`
