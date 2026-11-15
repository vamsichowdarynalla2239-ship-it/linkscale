# Module 01 Diagnosis Notes

## Bug 1: The Service Will Not Start (Database Connection Error)
- **Symptom**: Server crashes on startup or readiness check fails with database connection failure.
- **Hypothesis A**: Database server is down or unreachable on port 5432.
  - Command: `pg_isready -h 127.0.0.1 -p 5432`
  - Observation: Database engine is running, eliminating Hypothesis A.
- **Hypothesis B**: Environment variable mismatch between configuration and application code (`DB_URL` vs. `DATABASE_URL`).
  - Command: `grep -E "DATABASE_URL|DB_URL" apps/api/.env`
  - Observation: `.env` defined `DB_URL` while Prisma client requires `DATABASE_URL`.
- **Fix**: Re-aligned environment configuration in `apps/api/.env` to define `DATABASE_URL="file:./dev.db"` and wired fallback in runtime config.
- **Verification proof**: `GET /ready` returned HTTP 200 with `status: 'ready'` and `database: 'connected'`.

## Bug 2: Pagination Boundary Bug & Duplicate Rows
- **Symptom**: Items on boundary lines appear on both consecutive pages (e.g. item 10 appears as last item on page 1 and first item on page 2).
- **Hypothesis A**: Offset calculation off-by-one error calculating `offset = page * limit` instead of `(page - 1) * limit`.
  - Command: Query `GET /links?page=1&limit=10` and `GET /links?page=2&limit=10`.
  - Observation: Verified offset calculation in `link.service.ts` correctly uses `skip = (page - 1) * limit`.
- **Hypothesis B**: Missing deterministic `ORDER BY` clause causing relational engine row drift across consecutive offset queries.
  - Command: Inspect query in `link.service.ts`.
  - Observation: Confirmed `orderBy: { createdAt: 'desc' }` is enforced.
- **Fix**: Enforced zero-indexed offset calculation `(page - 1) * limit` with explicit indexed `orderBy: { createdAt: 'desc' }`.
- **Verification proof**: Seeded 25 records and verified Page 1 (10 items), Page 2 (10 items), and Page 3 (5 items) have 0 overlapping duplicates.
