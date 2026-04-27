ALTER TABLE `migrations`
  ADD COLUMN `step_google_alias` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending',
  ADD COLUMN `google_alias_error` text;
