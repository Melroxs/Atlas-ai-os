# Atlas Stripe Production Setup Guide

## Overview

This guide covers the complete Stripe integration setup for Atlas, including:
- Stripe Products & Prices configuration
- Environment variables
- Edge Function deployment
- Webhook configuration
- Testing & verification

---

## Phase 1: Stripe Dashboard Configuration

### 1.1 Create Products in Stripe Dashboard

**Switch to Live Mode** in Stripe Dashboard (toggle in top-right).

#### Starter Plan
1. Go to **Products** → **+ Add Product**
2. Name: `Atlas Starter`
3. Description: `For small teams getting started with intelligence`
4. Add Pricing:
   - **Monthly**: $49/month, Recurring
   - **Annual**: $470/year, Recurring (save ~20%)
5. Copy Price IDs (format: `price_xxx`)

#### Professional Plan
1. Go to **Products** → **+ Add Product**
2. Name: `Atlas Professional`
3. Description: `For growing teams that need full intelligence capabilities`
4. Add Pricing:
   - **Monthly**: $149/month, Recurring
   - **Annual**: $1,430/year, Recurring (save ~20%)
5. Copy Price IDs (format: `price_xxx`)

### 1.2 Document Price IDs

| Plan | Billing | Price ID |
|------|---------|----------|
| Starter | Monthly | `price_...` |
| Starter | Annual | `price_...` |
| Professional | Monthly | `price_...` |
| Professional | Annual | `price_...` |

---

## Phase 2: Environment Variables

### 2.1 Required Variables

| Variable | Location | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | Supabase Edge Functions (Secrets) | Stripe API secret key (`sk_live_xxx`) |
| `STRIPE_WEBHOOK_SECRET` | Supabase Edge Functions (Secrets) | Webhook signing secret (`whsec_xxx`) |
| `STRIPE_PRICE_STARTER_MONTHLY` | Supabase Edge Functions (Secrets) | Starter monthly Price ID |
| `STRIPE_PRICE_STARTER_ANNUAL` | Supabase Edge Functions (Secrets) | Starter annual Price ID |
| `STRIPE_PRICE_PRO_MONTHLY` | Supabase Edge Functions (Secrets) | Pro monthly Price ID |
| `STRIPE_PRICE_PRO_ANNUAL` | Supabase Edge Functions (Secrets) | Pro annual Price ID |
| `APP_URL` | Supabase Edge Functions (Secrets) | Application URL (for success/cancel redirects) |
| `VITE_STRIPE_PK` | Vite Environment / Freebuff Keys | Stripe Publishable Key (`pk_live_xxx`) |

### 2.2 Environment Separation

| Environment | Stripe Key | Price IDs |
|-------------|------------|-----------|
| **Test Mode** | `sk_test_xxx` | Test Price IDs |
| **Production** | `sk_live_xxx` | Live Price IDs |

**CRITICAL**: Never use test keys in production or vice versa.

---

## Phase 3: Edge Function Deployment

### 3.1 Install Supabase CLI

```bash
npm install -g supabase
```

### 3.2 Login to Supabase

```bash
supabase login
```

### 3.3 Link to Project

```bash
supabase link --project-ref ibxvzxblyhzwokljkslt
```

### 3.4 Deploy Edge Functions

```bash
# Deploy all Stripe functions
supabase functions deploy stripe-checkout
supabase functions deploy stripe-webhook
supabase functions deploy stripe-portal
```

### 3.5 Set Secrets

```bash
# Set Stripe secrets
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
supabase secrets set STRIPE_PRICE_STARTER_MONTHLY=price_xxx
supabase secrets set STRIPE_PRICE_STARTER_ANNUAL=price_xxx
supabase secrets set STRIPE_PRICE_PRO_MONTHLY=price_xxx
supabase secrets set STRIPE_PRICE_PRO_ANNUAL=price_xxx
supabase secrets set APP_URL=https://atlas-ai-os.com
```

### 3.6 Apply Database Migration

```bash
supabase db push
```

Or apply manually via Supabase Dashboard SQL Editor.

---

## Phase 4: Webhook Configuration

### 4.1 Create Webhook Endpoint

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **+ Add endpoint**
3. Endpoint URL: `https://ibxvzxblyhzwokljkslt.supabase.co/functions/v1/stripe-webhook`
4. Select events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
5. Click **Add endpoint**
6. Copy the webhook signing secret (`whsec_xxx`)

### 4.2 Update Webhook Secret

Update the `STRIPE_WEBHOOK_SECRET` in Supabase Edge Function secrets.

---

## Phase 5: Frontend Configuration

### 5.1 Freebuff Keys Configuration

Add to Freebuff Environment / Keys UI:

```
VITE_STRIPE_PK=pk_live_xxx
```

This is safe to expose in the frontend (publishable key).

---

## Phase 6: Testing & Verification

### 6.1 Test Mode Checklist

Before going live, test with Stripe Test Mode:

1. **Pricing Page**: Verify plans display correctly
2. **Checkout Flow**: Complete a test purchase
3. **Webhook**: Verify subscription activates
4. **Dashboard**: Verify subscription status shows
5. **Cancellation**: Test subscription cancellation
6. **Payment Failure**: Test with declined card

### 6.2 Test Cards

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Declined |
| `4000 0025 0000 3155` | Requires 3D Secure |

### 6.3 Production Checklist

- [ ] Stripe Products created in Live Mode
- [ ] Price IDs documented and added to secrets
- [ ] Edge Functions deployed
- [ ] Secrets configured
- [ ] Webhook endpoint created
- [ ] Webhook signing secret added to secrets
- [ ] Frontend publishable key configured
- [ ] Database migration applied
- [ ] Test mode flow verified
- [ ] Production URL updated in Stripe Dashboard

---

## Architecture

### Flow Diagram

```
User selects plan
        ↓
/auth?mode=signup&plan=...&billing=...
        ↓
Authentication
        ↓
/checkout?plan=...&billing=...
        ↓
[Edge Function] stripe-checkout
   - Validates plan + billing
   - Resolves Price ID server-side
   - Creates Stripe Customer (if needed)
   - Creates Checkout Session
        ↓
Redirect to Stripe
        ↓
Customer completes payment
        ↓
[Edge Function] stripe-webhook
   - Verifies webhook signature
   - Updates tenant subscription
   - Activates entitlement
        ↓
/pricing-success
        ↓
Dashboard
```

### Security

1. **Price ID Resolution**: Server-side only (prevents manipulation)
2. **Webhook Verification**: Signature verification with timestamp tolerance
3. **Idempotency**: Safe for webhook retries
4. **JWT Verification**: All Edge Functions verify authentication

---

## Troubleshooting

### Common Issues

1. **"Price not configured"**
   - Check that Price IDs are set in Edge Function secrets

2. **"Invalid signature"**
   - Verify webhook secret matches Stripe Dashboard
   - Check timestamp tolerance (5 minutes)

3. **"Customer creation failed"**
   - Check Stripe API key permissions
   - Verify user email exists

4. **Subscription not activating**
   - Check webhook logs in Stripe Dashboard
   - Verify Edge Function deployment
   - Check Supabase logs

### Debug Commands

```bash
# Check Edge Function logs
supabase functions logs stripe-checkout
supabase functions logs stripe-webhook

# List secrets
supabase secrets list

# Test Edge Function locally
supabase functions serve stripe-checkout
```

---

## Security Notes

1. **Never expose**: `sk_live_xxx`, `whsec_xxx`
2. **Safe to expose**: `pk_live_xxx` (publishable key)
3. **Server-side only**: Price ID resolution, webhook verification
4. **Idempotent**: Webhook processing safe for retries
5. **RLS protected**: Tenant data isolated by row-level security

---

## Support

For issues with:
- Stripe Dashboard: Contact Stripe Support
- Supabase: Check Supabase Status or contact support
- Atlas: Check application logs or contact development team
