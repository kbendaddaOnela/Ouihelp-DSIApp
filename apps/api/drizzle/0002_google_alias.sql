ALTER TABLE `migrations`
  ADD COLUMN IF NOT EXISTS `step_google_alias` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS `google_alias_error` text;
