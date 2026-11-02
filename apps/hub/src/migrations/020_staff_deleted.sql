-- «Удалить сотрудника» in a coffee shop (StaffService.delete, right staff.delete — its director).
--
-- A deleted person is gone from the staff list, the login roster and every picker, but the row
-- stays: access_keys and auth_sessions reference it, and the journal, receipts, the archive and
-- reports name people by it. `deleted_at` marks it (the person is also inactive, keys revoked).
ALTER TABLE staff ADD COLUMN deleted_at INTEGER;

-- Before this, a coffee shop could only switch people off, and they stayed in its list as
-- «Отключён». For the owner those people are removed: mark them deleted so they disappear after
-- the update too. Only people created on this HUB — the cabinet's people follow the cabinet.
-- Billiard clubs keep their switched-off people as they are.
UPDATE staff SET deleted_at = updated_at
WHERE is_active = 0
  AND deleted_at IS NULL
  AND origin = 'hub'
  AND club_id IN (
    SELECT id FROM clubs
    WHERE (CASE WHEN json_valid(settings) THEN json_extract(settings, '$.business.type') END) = 'cafe'
  );

-- Their keys can no longer be used (an inactive person never signs in); close them for good too.
UPDATE access_keys SET revoked_at = (SELECT updated_at FROM staff WHERE staff.id = access_keys.staff_id), revoked_by = 'system'
WHERE revoked_at IS NULL
  AND staff_id IN (SELECT id FROM staff WHERE deleted_at IS NOT NULL);
UPDATE auth_sessions SET revoked_at = (SELECT updated_at FROM staff WHERE staff.id = auth_sessions.staff_id)
WHERE revoked_at IS NULL
  AND staff_id IN (SELECT id FROM staff WHERE deleted_at IS NOT NULL);
