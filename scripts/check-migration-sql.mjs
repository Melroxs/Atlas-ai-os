const migration = require('../../supabase/migrations/20261007_atlas_paystack_billing.sql')

// Quick smoke check against the migration text to confirm it is not destructive.
const sql = migration.default ?? migration
console.log('migration bytes:', new TextEncoder().encode(sql).length)
console.log('has drop table:', /drop\s+table/i.test(sql))
console.log('has alter column ... type:', /\balter\s+table\b[^;]*\btype\b/i.test(sql))
console.log('has truncate:', /\btruncate\b/i.test(sql))
console.log('references billing_transactions:', sql.includes('billing_transactions'))
console.log('references processed_webhook_events:', sql.includes('processed_webhook_events'))
console.log('references provider_subscription_token:', sql.includes('provider_subscription_token'))
console.log('contains paystack:', sql.toLowerCase().includes('paystack'))
console.log('contains stripe:', sql.toLowerCase().includes('stripe'))
