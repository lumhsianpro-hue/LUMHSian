-- LUMHSian performance upgrade. Run in Supabase SQL Editor as the project owner.
-- The count function runs as the signed-in caller, so existing table grants and
-- RLS policies still decide which rows are visible. No policies are weakened.

CREATE OR REPLACE FUNCTION public.get_content_counts()
RETURNS TABLE (kind text, content_id bigint, total_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 'questions_paper'::text, paper_id::bigint, count(*)
  FROM public.questions
  WHERE paper_id IS NOT NULL
  GROUP BY paper_id

  UNION ALL
  SELECT 'questions_test'::text, practice_test_id::bigint, count(*)
  FROM public.questions
  WHERE practice_test_id IS NOT NULL
  GROUP BY practice_test_id

  UNION ALL
  SELECT 'questions_module'::text, module_id::bigint, count(*)
  FROM public.questions
  WHERE module_id IS NOT NULL AND paper_id IS NULL
  GROUP BY module_id

  UNION ALL
  SELECT 'questions_subject'::text, subject_id::bigint, count(*)
  FROM public.questions
  WHERE subject_id IS NOT NULL
  GROUP BY subject_id

  UNION ALL
  SELECT 'active_tests_subject'::text, subject_id::bigint, count(*)
  FROM public.practice_tests
  WHERE is_active IS TRUE AND subject_id IS NOT NULL
  GROUP BY subject_id

  UNION ALL
  SELECT 'active_tests_module'::text, module_id::bigint, count(*)
  FROM public.practice_tests
  WHERE is_active IS TRUE AND subject_id IS NULL AND module_id IS NOT NULL
  GROUP BY module_id

  UNION ALL
  SELECT 'subjects_module'::text, module_id::bigint, count(*)
  FROM public.subjects
  WHERE module_id IS NOT NULL
  GROUP BY module_id;
$$;

REVOKE ALL ON FUNCTION public.get_content_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_content_counts() TO authenticated;

-- Keep the existing admin predicate and privileges, but evaluate auth.uid()
-- once as a scalar subquery when RLS policies call this helper.
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_uid = (SELECT auth.uid()) AND is_admin IS TRUE
  );
$$;

-- Add useful indexes only where the table and column are present. This keeps
-- the migration compatible with installations that have optional tables.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('questions', 'subject_id', 'idx_perf_questions_subject'),
      ('questions', 'module_id', 'idx_perf_questions_module'),
      ('questions', 'paper_id', 'idx_perf_questions_paper'),
      ('questions', 'practice_test_id', 'idx_perf_questions_test'),
      ('practice_tests', 'subject_id', 'idx_perf_tests_subject'),
      ('practice_tests', 'module_id', 'idx_perf_tests_module'),
      ('practice_tests', 'is_active', 'idx_perf_tests_active'),
      ('subjects', 'module_id', 'idx_perf_subjects_module'),
      ('users', 'auth_uid', 'idx_perf_users_auth_uid'),
      ('users', 'email', 'idx_perf_users_email'),
      ('user_stats', 'email', 'idx_perf_user_stats_email'),
      ('bookmarks', 'email', 'idx_perf_bookmarks_email'),
      ('wrong_attempts', 'email', 'idx_perf_wrong_email'),
      ('inbox_messages', 'user_email', 'idx_perf_inbox_user'),
      ('inbox_messages', 'created_at', 'idx_perf_inbox_created'),
      ('reports_feedback', 'user_email', 'idx_perf_reports_user'),
      ('reports_feedback', 'created_at', 'idx_perf_reports_created'),
      ('announcements', 'created_at', 'idx_perf_announcements_created'),
      ('announcements', 'is_active', 'idx_perf_announcements_active'),
      ('app_notifications', 'created_at', 'idx_perf_notifications_created'),
      ('activity_logs', 'user_email', 'idx_perf_activity_user'),
      ('activity_logs', 'created_at', 'idx_perf_activity_created'),
      ('subscriptions', 'user_email', 'idx_perf_subscriptions_user'),
      ('users', 'user_id', 'idx_perf_users_user_id')
    ) AS requested(table_name, column_name, index_name)
  LOOP
    IF to_regclass(format('public.%I', item.table_name)) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = item.table_name
           AND column_name = item.column_name
       ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)',
        item.index_name, item.table_name, item.column_name
      );
    END IF;
  END LOOP;
END
$$;

ANALYZE public.questions;
ANALYZE public.practice_tests;
ANALYZE public.subjects;
ANALYZE public.user_stats;
