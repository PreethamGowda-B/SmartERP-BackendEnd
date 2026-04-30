# Bugfix Requirements Document

## Introduction

Three critical production bugs are affecting the SmartERP customer portal. The first causes job approval status to reset to "pending" after a page refresh, breaking the owner's approval workflow. The second prevents employees from seeing customer messages in their Messages tab — only owner chat is visible, making the job chat system one-sided. The third prevents customers from seeing a review/rating option after a job is completed, meaning feedback is never collected and jobs are never marked 100% complete.

All three fixes are strictly additive: no existing working features are modified, and multi-tenant isolation is preserved throughout.

---

## Bug Analysis

### Current Behavior (Defect)

**Issue 1 — Customer Job Approval Resets After Refresh**

1.1 WHEN an owner approves a customer job AND then refreshes the page THEN the system shows the "Approve" button again instead of the "Approved" state

1.2 WHEN the GET API returns a job's `approval_status` THEN the system returns `NULL` for legacy rows instead of treating `NULL` as `'approved'`, causing the frontend to render the approval button incorrectly

1.3 WHEN the frontend receives a successful approval response THEN the system does not update local state or refetch the job, so the stale pre-approval state is displayed until a hard refresh

**Issue 2 — Employee Chat Does Not Show Customer Messages**

2.1 WHEN a customer sends a message on a job THEN the employee assigned to that job cannot see the message in their Messages tab

2.2 WHEN an employee opens the Messages tab THEN the system only shows owner-to-employee direct messages, not customer job chat conversations

2.3 WHEN the employee Messages tab loads conversations THEN the system does not query the `job_messages` table for jobs assigned to that employee, so customer messages are invisible

2.4 WHEN an employee sends a reply in a job chat THEN the system does not route the message exclusively to the customer — it has no dedicated customer-facing delivery path

**Issue 3 — Review / Rating Not Shown After Job Completion**

3.1 WHEN a job's status is `'completed'` THEN the customer does not see a "Rate your experience" section on the job detail page

3.2 WHEN a customer attempts to submit a review THEN the system has no backend endpoint to accept or persist the review data

3.3 WHEN a job is marked as completed THEN the system does not set `progress = 100`, so the job is never shown as fully complete

3.4 WHEN a review has already been submitted for a job THEN the system has no guard to prevent a second submission (no duplicate protection exists)

---

### Expected Behavior (Correct)

**Issue 1 — Customer Job Approval Resets After Refresh**

2.1 WHEN an owner approves a customer job THEN the system SHALL persist `approval_status = 'approved'` and `approved_at = NOW()` using a transaction with a conditional `WHERE approval_status = 'pending_approval'` guard

2.2 WHEN the GET API returns a job's `approval_status` THEN the system SHALL use `COALESCE(approval_status, 'approved')` so that legacy `NULL` rows are always treated as approved

2.3 WHEN the frontend receives a successful approval response THEN the system SHALL either refetch the job from the API or update the local state immediately, so the "Approved" state is shown without requiring a page refresh

**Issue 2 — Employee Chat Does Not Show Customer Messages**

2.4 WHEN an employee opens the Messages tab THEN the system SHALL display all customer job conversations for jobs assigned to that employee, grouped by job, alongside existing owner direct messages

2.5 WHEN the employee Messages tab loads THEN the system SHALL query `job_messages` grouped by `job_id` and `company_id`, returning customer name, company name, job title, last message, and unread count for each conversation

2.6 WHEN an employee sends a message in a job chat THEN the system SHALL route the message exclusively to the customer of that job (not broadcast), and publish a `chat_message` SSE event to `customer_job_events:{jobId}`

2.7 WHEN a customer sends a message on a job THEN the system SHALL store it in `job_messages` with `sender_type = 'customer'` and make it immediately visible to the assigned employee via the `GET /api/messages/job/:jobId` endpoint

**Issue 3 — Review / Rating Not Shown After Job Completion**

2.8 WHEN a job's status is `'completed'` AND `review_rating IS NULL` THEN the system SHALL display a star rating section (1–5 stars), a comment box, and a submit button on the customer job detail page

2.9 WHEN a customer submits a review THEN the system SHALL persist `review_rating`, `review_comment`, and `review_submitted_at` on the job row, set `progress = 100`, and return a success response

2.10 WHEN a review is submitted THEN the system SHALL enforce that only the customer who owns the job can submit, only if `status = 'completed'`, and only once (duplicate submissions SHALL be rejected with a 409 response)

2.11 WHEN a review has been submitted THEN the system SHALL display the submitted rating and comment (e.g. "⭐ 4/5 — Good service") and disable the review form

---

### Unchanged Behavior (Regression Prevention)

**Issue 1 — Approval Workflow**

3.1 WHEN an owner rejects a customer job THEN the system SHALL CONTINUE TO set `approval_status = 'rejected'` and `status = 'cancelled'` correctly

3.2 WHEN a job was created by an owner (not a customer) THEN the system SHALL CONTINUE TO function without any approval workflow involvement

3.3 WHEN the auto-approve setting is enabled for a company THEN the system SHALL CONTINUE TO auto-approve new customer jobs at creation time without requiring manual owner action

**Issue 2 — Messaging**

3.4 WHEN an owner or employee sends a direct message to another user THEN the system SHALL CONTINUE TO use the existing `messages` table and `POST /api/messages` endpoint without any changes

3.5 WHEN an employee fetches their direct message conversations via `GET /api/messages/conversations` THEN the system SHALL CONTINUE TO return owner-to-employee conversations as before

3.6 WHEN a message is sent between users in the same company THEN the system SHALL CONTINUE TO enforce company isolation (no cross-company messages)

**Issue 3 — Job Completion & Progress**

3.7 WHEN an employee updates job progress to any value below 100 THEN the system SHALL CONTINUE TO update the progress field without triggering review logic

3.8 WHEN a job is in any status other than `'completed'` THEN the system SHALL CONTINUE TO hide the review section from the customer

3.9 WHEN an employee profile rating is updated THEN the system SHALL CONTINUE TO store the average rating without affecting any other employee profile fields

3.10 WHEN a customer views a job that already has a submitted review THEN the system SHALL CONTINUE TO display the review in read-only mode and SHALL NOT allow re-submission

---

## Bug Condition Pseudocode

### Issue 1 — Approval Reset

```pascal
FUNCTION isBugCondition_ApprovalReset(X)
  INPUT: X of type { jobId, approval_status_in_db, frontend_state_after_approval }
  OUTPUT: boolean

  RETURN X.approval_status_in_db = NULL
      OR X.frontend_state_after_approval = 'pending_approval'
END FUNCTION

// Property: Fix Checking
FOR ALL X WHERE isBugCondition_ApprovalReset(X) DO
  result ← getJob'(X.jobId)
  ASSERT result.approval_status = 'approved'
  ASSERT frontend shows "Approved" without requiring refresh
END FOR

// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_ApprovalReset(X) DO
  ASSERT getJob(X) = getJob'(X)
END FOR
```

### Issue 2 — Employee Chat Visibility

```pascal
FUNCTION isBugCondition_ChatInvisible(X)
  INPUT: X of type { employeeId, jobId, senderType }
  OUTPUT: boolean

  RETURN X.senderType = 'customer'
      AND job.assigned_to = X.employeeId
      AND message NOT IN employee_messages_tab
END FUNCTION

// Property: Fix Checking
FOR ALL X WHERE isBugCondition_ChatInvisible(X) DO
  result ← getJobConversations'(X.employeeId)
  ASSERT result contains conversation for X.jobId
  ASSERT result.messages includes customer messages
END FOR

// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_ChatInvisible(X) DO
  ASSERT getDirectMessages(X) = getDirectMessages'(X)
END FOR
```

### Issue 3 — Review Not Shown

```pascal
FUNCTION isBugCondition_ReviewMissing(X)
  INPUT: X of type { jobId, status, review_rating }
  OUTPUT: boolean

  RETURN X.status = 'completed'
      AND X.review_rating IS NULL
      AND review_section NOT visible to customer
END FUNCTION

// Property: Fix Checking
FOR ALL X WHERE isBugCondition_ReviewMissing(X) DO
  result ← getJobDetail'(X.jobId)
  ASSERT result shows review section
  ASSERT POST /review succeeds and persists rating
  ASSERT job.progress = 100 after review submission
END FOR

// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_ReviewMissing(X) DO
  ASSERT getJobDetail(X) = getJobDetail'(X)
  ASSERT review section is hidden when status != 'completed'
END FOR
```
