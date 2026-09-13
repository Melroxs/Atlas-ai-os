# Atlas Regulatory Intelligence — Wave 1 Acquisition Report

**Generated:** 2026-09-06T19:51:02.312Z  
**Source of counts:** persisted Supabase regulatory tables; no estimates are used.

## Wave 1 counts

| Jurisdiction | Sources | Primary | Propositions | Verified | Review | Contradictions | Coverage |
| ------------ | ------: | ------: | -----------: | -------: | -----: | -------------: | -------: |
| FL | 5 | 5 | 188 | 0 | 183 | 0 | 55% |
| TX | 3 | 3 | 70 | 0 | 69 | 0 | 67% |
| CA | 3 | 3 | 174 | 0 | 173 | 535 | 67% |
| NY | 3 | 3 | 0 | 0 | 2 | 0 | 13% |
| CO | 3 | 3 | 23 | 0 | 22 | 0 | 33% |
| MD | 3 | 3 | 0 | 0 | 2 | 0 | 13% |
| GA | 3 | 3 | 78 | 0 | 73 | 0 | 45% |
| LA | 3 | 3 | 0 | 0 | 2 | 0 | 13% |
| AZ | 3 | 3 | 31 | 0 | 32 | 465 | 16% |
| WA | 2 | 2 | 274 | 0 | 266 | 0 | 0% |

## Interpretation

Counts are proposition- and evidence-aware. Downloading a page does not make a jurisdiction complete. Secondary sources remain discovery-only, unverified material is not silently promoted, unresolved contradictions remain visible, and historical proposition versions remain addressable through the version tables.

If no migration or acquisition has been run, zeros are the correct output. The generator intentionally fails when durable database credentials are missing rather than generating a fabricated report.

## Operational references

- Migration: `supabase/migrations/20260906_atlas_regulatory_intelligence.sql`
- Schema verification: `supabase/verification/20260906_atlas_regulatory_verification.sql`
- Acquisition worker: `scripts/acquire-regulatory-wave1.ts`
- Queue processor: `scripts/process-regulatory-jobs.ts`
