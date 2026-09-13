-- ============================================================================
-- DIAGNOSTIC: Super Admin Login State
-- Run this in Supabase SQL Editor, then DELETE this file.
-- ============================================================================

-- 1. Auth user exists? Email confirmed?
SELECT 
  id,
  email,
  email_confirmed_at,
  created_at,
  last_sign_in_at,
  banned_until,
  raw_user_meta_data->>'full_name' AS meta_name
FROM auth.users
WHERE email ILIKE '%melissa%'
   OR email ILIKE '%admin%'
   OR email ILIKE '%super%'
ORDER BY created_at;

-- 2. Profile exists? Role and status correct?
SELECT 
  p._id,
  p.name,
  p.email,
  p.platform_role,
  p.account_status,
  p.role
FROM public.profiles p
WHERE p.email ILIKE '%melissa%'
   OR p.email ILIKE '%admin%'
   OR p.email ILIKE '%super%';

-- 3. Membership exists? Status? Which tenant?
SELECT 
  m."userId",
  m."tenantId",
  m.role,
  m.status,
  m."_creationTime"
FROM public.memberships m
WHERE m."userId" IN (
  SELECT id FROM auth.users 
  WHERE email ILIKE '%melissa%'
     OR email ILIKE '%admin%'
     OR email ILIKE '%super%'
);

-- 4. Onboarding complete for that tenant?
SELECT 
  cp."tenantId",
  cp."companyName",
  cp."onboardingComplete"
FROM public."companyProfiles" cp
WHERE cp."tenantId" IN (
  SELECT m."tenantId" FROM public.memberships m
  WHERE m."userId" IN (
    SELECT id FROM auth.users 
    WHERE email ILIKE '%melissa%'
       OR email ILIKE '%admin%'
       OR email ILIKE '%super%'
  )
);

-- 5. ALL users and their roles (for comparison with YC Demo)
SELECT 
  p._id,
  p.email,
  p.platform_role,
  p.account_status,
  p.role
FROM public.profiles p
ORDER BY p.platform_role NULLS LAST, p.email;
