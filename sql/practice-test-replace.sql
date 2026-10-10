CREATE OR REPLACE FUNCTION public.admin_replace_practice_test_questions(
  p_test_id BIGINT,
  p_questions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_test public.practice_tests%ROWTYPE;
  v_question JSONB;
  v_option JSONB;
  v_correct_answer NUMERIC;
  v_old_count INTEGER;
  v_new_count INTEGER;You are working on LUMHSian Pro, my live medical education PWA (HTML/JS, Supabase backend, deployed on GitHub Pages). Real students use this app. I am the sole admin and I rely on you for the code, so be careful and precise. Your first priority is: DO NOT BREAK ANYTHING THAT ALREADY WORKS. Your second priority is the new feature.

=== STEP 0: SAFETY SETUP (do this first) ===
- Create a new git branch named feature/practice-test-download-replace and work only on it. Never commit to main.
- Do not delete, rename, or move any existing file or function.

=== STEP 1: EXPLORE ONLY (no code changes yet) ===
Read the repo and find:
a) the admin panel code and how it checks that a user is admin
b) the practice tests code (how tests and MCQs are stored in Supabase: table names, columns)
c) the existing bulk upload tool (file format and parser)
d) the existing "PDF download for past papers" code
e) how student attempts/results/leaderboard reference questions
Then write a short plan: which files you will edit, what you will add, and any risk you see. Keep the plan small. Only after writing the plan, continue to Step 2.

=== STEP 2: THE FEATURE ===
Admin-only Download and Replace for every Practice Test.

1) DOWNLOAD
- In the Admin Panel, next to each practice test, add a "Download" button.
- It downloads the full test with every MCQ: question text, all options, the correct option, and the explanation.
- Use the exact same file format that my existing bulk upload tool accepts, so a downloaded file can be edited and uploaded back without conversion. If the bulk upload format lacks a field (like explanation or correct answer), extend the download and the parser consistently, without changing how the old format works.
- File name: test title + date.

2) REPLACE
- Next to Download, add a "Replace" button for each practice test.
- Admin picks a file (same format as Download). Parse and validate FIRST: every MCQ needs question text, options, one correct option, and an explanation. If anything is invalid, show clear errors with the question number and do NOT touch the database.
- After validation, show a confirm dialog with old MCQ count vs new MCQ count.
- On confirm, replace the MCQs of that same test with the uploaded ones, including explanations. Keep the test's ID, title, and settings unchanged.
- Must be safe: use a single transaction or Supabase RPC if possible. Otherwise insert the new questions first and delete the old ones only after the insert succeeds. A failed upload must never leave the test empty.
- Check how student attempts, results, and leaderboard reference questions. Replacing must not corrupt or break existing student results. Tell me what you found and how you handled it.

3) SECURITY
- Buttons visible to admins only, never students.
- Also enforce it server-side (Supabase RLS policy or admin-checked RPC), using the same admin check my existing admin features use.
- Never put API keys or service-role keys in client code.

4) UX
- Loading states and success/error toasts in the same style as the existing app.
- Must work on mobile (PWA).
- Sanitize/escape all content when parsing and rendering.

=== STRICT RULES (follow all of them) ===
1. Make the SMALLEST possible change. Add new functions instead of modifying old ones. Only touch an existing function if it is truly required, and say why.
2. Do NOT refactor, rename, reformat, or "clean up" any existing code.
3. Do NOT change existing features: student test engine, leaderboard, past papers, auth (Google OAuth), announcements, donations, USMLE track, bulk upload, existing PDF download. They must work exactly as before.
4. Do NOT add new libraries or frameworks unless absolutely unavoidable. If you must, tell me first and explain why.
5. Do NOT change the existing database schema in a destructive way. No dropping tables, columns, or policies. Only additive changes.
6. Do NOT guess table names, column names, or function names. Read them from the code. If something is unclear, say so instead of inventing.
7. Keep the same coding style, naming, and CSS classes as the existing code.
8. Make changes in small steps. After each step, re-read the edited code and check for syntax errors, undefined variables, missing brackets, and duplicate function names.
9. Make sure the service worker/PWA caching does not break (if you add or change files, check whether the service worker cache list or version needs an update, and tell me).
10. If you are unsure about anything risky, STOP and ask me instead of guessing.

=== STEP 3: SELF-CHECK BEFORE FINISHING ===
Go through this checklist and report the result of each point:
- Existing admin panel still loads and works
- Student side is unchanged
- Download file opens correctly and has explanations and correct options
- Downloaded file can be re-uploaded through Replace without errors
- Invalid file is rejected without changing the database
- Non-admin cannot see or use the buttons, and cannot call the replace operation directly
- No console errors, no undefined variables

=== DELIVERABLES ===
- The code changes in the branch.
- If any Supabase SQL (policy, RPC, column) is needed, give the exact SQL in a separate block that I can run in the Supabase SQL editor, and clearly mark whether it is safe to run on the live database.
- A short final summary: files changed, SQL to run, and step-by-step instructions to test it.
- Do not merge into main. I will test first.
  v_question_number INTEGER := 0;
BEGIN
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_test_id IS NULL THEN
    RAISE EXCEPTION 'Practice-test ID is required';
  END IF;
  IF jsonb_typeof(p_questions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Questions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_questions) < 1 OR jsonb_array_length(p_questions) > 2000 THEN
    RAISE EXCEPTION 'Question count must be between 1 and 2000';
  END IF;

  SELECT * INTO v_test
  FROM public.practice_tests
  WHERE id = p_test_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Practice test not found';
  END IF;

  FOR v_question IN SELECT value FROM jsonb_array_elements(p_questions)
  LOOP
    v_question_number := v_question_number + 1;
    IF jsonb_typeof(v_question) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Question % must be an object', v_question_number;
    END IF;
    IF jsonb_typeof(v_question->'text') IS DISTINCT FROM 'string'
       OR btrim(v_question->>'text') = ''
       OR length(v_question->>'text') > 5000 THEN
      RAISE EXCEPTION 'Question % needs non-empty text of at most 5000 characters', v_question_number;
    END IF;
    IF jsonb_typeof(v_question->'options') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Question % options must be an array', v_question_number;
    END IF;
    IF jsonb_array_length(v_question->'options') < 2 THEN
      RAISE EXCEPTION 'Question % needs at least two options', v_question_number;
    END IF;
    FOR v_option IN SELECT value FROM jsonb_array_elements(v_question->'options')
    LOOP
      IF jsonb_typeof(v_option) IS DISTINCT FROM 'string'
         OR btrim(v_option #>> '{}') = ''
         OR length(v_option #>> '{}') > 1000 THEN
        RAISE EXCEPTION 'Question % has an empty, invalid, or overlong option', v_question_number;
      END IF;
    END LOOP;
    IF jsonb_typeof(v_question->'correct_answer') IS DISTINCT FROM 'number'
       OR (v_question->>'correct_answer') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'Question % correct_answer must be a zero-based option index', v_question_number;
    END IF;
    v_correct_answer := (v_question->>'correct_answer')::NUMERIC;
    IF v_correct_answer >= jsonb_array_length(v_question->'options') THEN
      RAISE EXCEPTION 'Question % correct_answer does not identify an option', v_question_number;
    END IF;
    IF jsonb_typeof(v_question->'explanation') IS DISTINCT FROM 'string'
       OR btrim(v_question->>'explanation') = ''
       OR length(v_question->>'explanation') > 5000 THEN
      RAISE EXCEPTION 'Question % needs a non-empty explanation of at most 5000 characters', v_question_number;
    END IF;
    IF v_question ? 'image_url' AND jsonb_typeof(v_question->'image_url') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Question % image_url must be text or null', v_question_number;
    END IF;
    IF v_question ? 'explanation_image_url' AND jsonb_typeof(v_question->'explanation_image_url') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Question % explanation_image_url must be text or null', v_question_number;
    END IF;
    IF v_question ? 'difficulty' AND jsonb_typeof(v_question->'difficulty') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Question % difficulty must be text', v_question_number;
    END IF;
    IF COALESCE(v_question->>'difficulty', 'medium') NOT IN ('easy', 'medium', 'hard') THEN
      RAISE EXCEPTION 'Question % difficulty must be easy, medium, or hard', v_question_number;
    END IF;
    IF v_question ? 'tags' AND jsonb_typeof(v_question->'tags') NOT IN ('array', 'null') THEN
      RAISE EXCEPTION 'Question % tags must be an array', v_question_number;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_old_count
  FROM public.questions
  WHERE practice_test_id = p_test_id;

  -- Keep historical question IDs intact for bookmarks, wrong attempts, and reports.
  -- Removing the active links prevents old questions from appearing in the module or test pools.
  UPDATE public.questions
  SET module_id = NULL, practice_test_id = NULL
  WHERE practice_test_id = p_test_id;

  INSERT INTO public.questions (
    module_id, subject_id, practice_test_id, text, options, correct_answer,
    explanation, image_url, explanation_image_url, difficulty, tags
  )
  SELECT
    v_test.module_id,
    v_test.subject_id,
    p_test_id,
    q->>'text',
    q->'options',
    (q->>'correct_answer')::INTEGER,
    q->>'explanation',
    NULLIF(q->>'image_url', ''),
    NULLIF(q->>'explanation_image_url', ''),
    COALESCE(NULLIF(q->>'difficulty', ''), 'medium'),
    CASE WHEN jsonb_typeof(q->'tags') = 'array' THEN q->'tags' ELSE '[]'::JSONB END
  FROM jsonb_array_elements(p_questions) AS uploaded(q);

  GET DIAGNOSTICS v_new_count = ROW_COUNT;
  RETURN jsonb_build_object('old_count', v_old_count, 'new_count', v_new_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_replace_practice_test_questions(BIGINT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_practice_test_questions(BIGINT, JSONB) TO authenticated;