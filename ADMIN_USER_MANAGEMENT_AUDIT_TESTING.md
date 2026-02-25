# Admin User Management Audit - Testing Guide

This document outlines the test scenarios to verify the admin user management audit fixes are working correctly.

## Implementation Status ✅

All planned fixes have been implemented:

1. ✅ **Database Migration**: `0018_orders_cashier_fk_set_null.sql` - Updates FK to ON DELETE SET NULL
2. ✅ **SettingsPage Cloud Guards**: All user management mutations have `requireCloudSession()` 
3. ✅ **LoginScreen Stale Login Prevention**: Detects cloud account issues and purges local users
4. ✅ **Enhanced Error Feedback**: `friendlyAdminError()` and edge function provide actionable messages

## Test Scenarios

### Scenario 1: Delete staff with no orders (hard delete)
**Expected**: User is permanently deleted from auth and profiles
**Steps**:
1. Create a new staff user with no order history
2. As admin, go to Settings → User Management
3. Click delete on the new user
4. Confirm deletion

**Expected Results**:
- ✅ Success message "User deleted"
- ✅ User removed from profiles table
- ✅ User removed from auth.users
- ✅ User no longer appears in user list

### Scenario 2: Delete staff with orders (FK migration test)
**Expected**: User deleted, orders preserved with null cashier_id
**Steps**:
1. Create a staff user
2. Process several orders with this user as cashier
3. Delete the staff user
4. Check order history

**Expected Results**:
- ✅ Success message "User deleted"
- ✅ User removed from profiles and auth
- ✅ Orders still exist but cashier_id is now null
- ✅ Order history preserved

### Scenario 3: Local-only admin session attempts user management
**Expected**: Clear re-auth prompt, no action performed
**Steps**:
1. Go offline with admin credentials cached locally
2. Try to delete/create/modify a user
3. Observe error message

**Expected Results**:
- ✅ Error: "Cloud session missing. Sign out and sign in again while online."
- ✅ No changes made to users
- ✅ Guidance to re-authenticate

### Scenario 4: Deleted staff tries login on cached device (online)
**Expected**: Login blocked, local cache purged, clear error
**Steps**:
1. Staff user logs in on device (creates local cache)
2. Admin deletes the staff user account
3. Staff tries to login again while online
4. Check local storage

**Expected Results**:
- ✅ Login fails with clear error: "Your account no longer exists. Contact your admin."
- ✅ Local user record deleted from device storage
- ✅ Cannot bypass with cached credentials

### Scenario 5: Deleted staff tries login offline (edge case)
**Expected**: Offline login blocked if local cache was purged
**Steps**:
1. Staff user logs in, then admin deletes account
2. Staff goes offline
3. Attempts login

**Expected Results**:
- ✅ Login fails: "Offline login is not available for this user on this device"
- ✅ No local bypass possible

### Scenario 6: User with impersonation audit history
**Expected**: Clear guidance to deactivate instead of delete
**Steps**:
1. User has impersonation audit records
2. Admin tries to delete user
3. Observe error message

**Expected Results**:
- ✅ 409 error: "Cannot permanently delete this user because impersonation audit history exists. Deactivate instead."
- ✅ User remains in system
- ✅ Admin can choose to deactivate instead

### Scenario 7: Deactivate user (fallback when delete blocked)
**Expected**: User deactivated but preserved in system
**Steps**:
1. User has order history or audit records
2. Admin chooses "Deactivate" instead of delete
3. Check user status

**Expected Results**:
- ✅ Success message "User deactivated"
- ✅ User.active = false in profiles
- ✅ User cannot login
- ✅ Order history preserved with cashier reference

## Error Message Testing

### Cloud Session Errors
- **401/403/404**: "Cloud session missing. Sign out and sign in again while online."
- **Session invalid**: "Cloud session missing. Sign out and sign in again while online."

### Foreign Key Constraint Errors  
- **Orders FK**: "Cannot permanently delete this user because linked history exists. Deactivate instead."
- **Audit FK**: "Cannot permanently delete this user because impersonation audit history exists. Deactivate instead."

### Account Status Errors
- **Account disabled**: "Account disabled. Contact your admin."
- **Account deleted**: "Your account no longer exists. Contact your admin."
- **Credentials changed**: "Cloud credentials changed. Sign in again with your current password."

## Database Verification

After testing, verify the database state:

```sql
-- Check FK constraint is SET NULL
SELECT conname, confdeltype 
FROM pg_constraint 
WHERE conrelid = 'public.orders'::regclass 
  AND conname = 'orders_cashier_id_fkey';
-- Should show: confdeltype = 's' (SET NULL)

-- Check orders with deleted cashiers
SELECT id, cashier_id, created_at 
FROM public.orders 
WHERE cashier_id IS NULL 
  AND created_at > '2024-01-01';
-- Should show orders with null cashier_id after deletion

-- Check user deletion completeness
SELECT p.id, p.username, p.active, a.id as auth_id
FROM public.profiles p
LEFT JOIN auth.users a ON p.id = a.id
WHERE p.username = 'deleted_test_user';
-- Should return no rows for fully deleted users
```

## Performance Considerations

- **Migration impact**: One-time update of orphaned cashier_id values
- **Query performance**: Orders with null cashier_id still query efficiently  
- **Login flow**: Additional cloud auth check only when online

## Security Validation

- ✅ Admin-only operations protected by `requireCloudSession()`
- ✅ Business admins can only manage users in their business
- ✅ Platform admins have full management capabilities
- ✅ Deleted users cannot bypass via local cache
- ✅ Demo tenants protected from staff management abuse

## Rollback Plan

If issues arise, the FK constraint can be reverted:

```sql
-- Rollback migration (if needed)
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_cashier_id_fkey;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_cashier_id_fkey
  FOREIGN KEY (cashier_id)
  REFERENCES public.profiles (id)
  ON DELETE RESTRICT;
```

## Success Criteria

All test scenarios pass with:
1. ✅ Predictable user deletion behavior
2. ✅ Clear, actionable error messages  
3. ✅ No stale local login bypass
4. ✅ Preserved order history when appropriate
5. ✅ Proper session validation for admin actions

The admin user management system should now behave predictably with proper error handling and security boundaries.
