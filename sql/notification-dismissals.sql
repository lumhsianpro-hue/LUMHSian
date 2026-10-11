-- Per-student notification dismissals. Shared announcements, broadcasts, messages,
-- reports, and replies remain untouched; this table only hides their bell entries.
CREATE TABLE IF NOT EXISTS notification_dismissals (
  user_email TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('announce', 'notif', 'inbox', 'report_reply')),
  notification_id BIGINT NOT NULL CHECK (notification_id > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_email, source, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_dismissals_user
  ON notification_dismissals (user_email, created_at DESC);

ALTER TABLE notification_dismissals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_dismissals_select_own ON notification_dismissals;
DROP POLICY IF EXISTS notification_dismissals_insert_own ON notification_dismissals;

CREATE POLICY notification_dismissals_select_own
  ON notification_dismissals FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());

CREATE POLICY notification_dismissals_insert_own
  ON notification_dismissals FOR INSERT
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()));

GRANT SELECT, INSERT ON notification_dismissals TO authenticated;

CREATE TABLE IF NOT EXISTS notification_views (
  user_email TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('announce', 'notif')),
  notification_id BIGINT NOT NULL CHECK (notification_id > 0),
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_email, source, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_views_user
  ON notification_views (user_email, viewed_at DESC);

ALTER TABLE notification_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_views_select_own ON notification_views;
DROP POLICY IF EXISTS notification_views_insert_own ON notification_views;

CREATE POLICY notification_views_select_own
  ON notification_views FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());

CREATE POLICY notification_views_insert_own
  ON notification_views FOR INSERT
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()));

GRANT SELECT, INSERT ON notification_views TO authenticated;
