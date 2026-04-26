# Requirements Document

## Introduction

This document defines the requirements for extending the SmartERP system with a comprehensive Customer Job Approval Workflow and a suite of automation, business intelligence, and enterprise features. The extension is strictly additive — it does not modify existing core flows for Owner, HR, Employee, or Customer portals. All new functionality is modular, multi-tenant safe (company_id-isolated), and backward compatible with the current schema and API contracts.

The feature set is organized into six parts:
1. **Customer Job Approval Workflow** — approval gating, portal tabs, timeline tracking, and auto-approve toggle
2. **Core Automation** — smart dispatch, geofenced arrival detection, and SLA enforcement
3. **Business Features** — billing/invoicing, material usage tracking, and performance analytics
4. **Intelligence & UX** — AI-based job prioritization and real-time push notifications
5. **Enterprise Features** — extended RBAC, multi-branch support, and audit logging
6. **Advanced Capabilities** — offline mode, advanced customer features, API access, and white-label branding

---

## Glossary

- **System**: The SmartERP backend and frontend application
- **Approval_Service**: The backend module responsible for evaluating and transitioning job approval states
- **Dispatch_Service**: The backend module responsible for automatically assigning employees to approved jobs
- **Geofence_Service**: The backend module that monitors employee GPS coordinates against job location radii
- **SLA_Service**: The backend module that tracks and reports Service Level Agreement compliance
- **Billing_Service**: The backend module that generates invoices after job completion
- **Notification_Service**: The existing notification infrastructure extended to support new event types
- **Analytics_Service**: The backend module that computes employee and company performance metrics
- **AI_Prioritization_Service**: The backend module that analyzes job descriptions and assigns priority scores
- **Audit_Service**: The backend module that records all user actions to the audit log
- **Owner_Portal**: The existing web interface used by company owners (role = 'owner')
- **HR_Portal**: The existing web interface used by HR staff (role = 'hr')
- **Employee_Portal**: The existing web interface used by field employees (role = 'employee')
- **Customer_Portal**: The existing web interface used by registered customers
- **Job**: A work order record stored in the `jobs` table
- **Customer**: A registered user in the `customers` table
- **Employee**: A registered user in the `users` table with role = 'employee'
- **Company**: A tenant record in the `companies` table, identified by `company_id`
- **Branch**: A sub-unit of a Company, identified by `branch_id`
- **SLA_Config**: A company-level configuration record defining `max_accept_time` and `max_completion_time`
- **Invoice**: A billing record generated after job completion
- **Audit_Log**: An immutable record of a user action stored in the `audit_logs` table
- **RBAC**: Role-Based Access Control — the permission model governing what each role can do
- **Auto_Approve**: A company-level boolean setting (`auto_approve_customer_jobs`) that bypasses manual approval
- **Geofence_Radius**: The fixed 100-meter radius around a job's location used for arrival detection
- **Smart_Dispatch**: The automated employee assignment algorithm using location, workload, and rating scores

---

## Requirements

### Requirement 1: Customer Job Approval Status

**User Story:** As an Owner or HR manager, I want customer-submitted jobs to enter a pending approval state so that I can review and control which jobs become visible to employees.

#### Acceptance Criteria

1. WHEN a Customer submits a new job via the Customer_Portal, THE Approval_Service SHALL set the job's `approval_status` to `pending_approval`.
2. WHERE the company setting `auto_approve_customer_jobs` is `true`, THE Approval_Service SHALL set the job's `approval_status` to `approved` immediately upon job creation, bypassing manual review.
3. WHEN an Owner or HR user approves a job, THE Approval_Service SHALL update the job's `approval_status` to `approved` and record the `approved_at` timestamp.
4. WHEN an Owner or HR user rejects a job, THE Approval_Service SHALL update the job's `approval_status` to `rejected` and record a `rejected_at` timestamp.
5. IF a job's `approval_status` is not `approved`, THEN THE System SHALL exclude that job from all Employee_Portal job listings and assignment queries.
6. THE System SHALL enforce `company_id` isolation on all approval status reads and writes, ensuring no cross-tenant data access.
7. WHEN the `approval_status` of a job changes, THE Approval_Service SHALL write an entry to the Audit_Log recording the actor's `user_id`, the `job_id`, the old status, the new status, and the timestamp.

---

### Requirement 2: Customer Jobs Tab in Owner and HR Portals

**User Story:** As an Owner or HR manager, I want a dedicated "Customer Jobs" tab in my portal so that I can view, filter, and act on all customer-submitted jobs in one place.

#### Acceptance Criteria

1. THE Owner_Portal SHALL display a "Customer Jobs" tab that lists all jobs where `source = 'customer'` for the authenticated company.
2. THE HR_Portal SHALL display a "Customer Jobs" tab that lists all jobs where `source = 'customer'` for the authenticated company.
3. WHEN the Customer Jobs tab is rendered, THE System SHALL display the following fields for each job: Job Title, Customer Name, Customer Company Name, Created Time, Priority, and a Status badge reflecting the current `approval_status`.
4. THE Customer Jobs tab SHALL provide an Approve action button for each job with `approval_status = 'pending_approval'`, which triggers Requirement 1 criterion 3.
5. THE Customer Jobs tab SHALL provide a Reject action button for each job with `approval_status = 'pending_approval'`, which triggers Requirement 1 criterion 4.
6. THE Customer Jobs tab SHALL provide filter controls for Status (`pending_approval`, `approved`, `rejected`), Priority (`low`, `medium`, `high`, `urgent`), and Date range (created_at).
7. WHEN a filter is applied, THE System SHALL return only jobs matching all active filter criteria within the authenticated company's scope.
8. THE System SHALL paginate the Customer Jobs tab results, returning a maximum of 50 records per page with total count metadata.

---

### Requirement 3: Job Timeline Tracking

**User Story:** As an Owner, HR manager, or Customer, I want to see a full timeline of key job milestones so that I can track progress and identify delays.

#### Acceptance Criteria

1. THE System SHALL store the following timeline timestamps on each job record: `created_at`, `approved_at`, `assigned_at`, `started_at`, `completed_at`.
2. WHEN a job is created by a Customer, THE System SHALL record `created_at` as the current UTC timestamp.
3. WHEN a job's `approval_status` transitions to `approved`, THE System SHALL record `approved_at` as the current UTC timestamp.
4. WHEN an employee is assigned to a job (either manually or via Smart_Dispatch), THE System SHALL record `assigned_at` as the current UTC timestamp.
5. WHEN an employee's `employee_status` on a job transitions to `accepted`, THE System SHALL record `started_at` as the current UTC timestamp.
6. WHEN a job's `progress` reaches 100 or `status` transitions to `completed`, THE System SHALL record `completed_at` as the current UTC timestamp.
7. THE Customer_Portal job detail view SHALL display all available timeline timestamps for the customer's own jobs.
8. THE Owner_Portal and HR_Portal job detail views SHALL display all timeline timestamps for any job within the company.

---

### Requirement 4: Auto-Approve Company Setting

**User Story:** As an Owner, I want to configure an auto-approve toggle for customer jobs so that low-risk companies can skip the manual approval step.

#### Acceptance Criteria

1. THE System SHALL store an `auto_approve_customer_jobs` boolean field in the company settings, defaulting to `false`.
2. WHEN an Owner updates the `auto_approve_customer_jobs` setting via the Owner_Portal settings page, THE System SHALL persist the new value scoped to the authenticated company.
3. WHILE `auto_approve_customer_jobs` is `true`, THE Approval_Service SHALL automatically approve all new customer-submitted jobs at creation time without requiring manual Owner or HR action.
4. WHILE `auto_approve_customer_jobs` is `false`, THE Approval_Service SHALL set new customer-submitted jobs to `pending_approval` and require manual review.
5. IF an Owner changes `auto_approve_customer_jobs` from `true` to `false`, THEN THE System SHALL NOT retroactively change the status of already-approved jobs.
6. THE System SHALL restrict modification of `auto_approve_customer_jobs` to users with role = 'owner' within the same company.

---

### Requirement 5: Smart Dispatch System

**User Story:** As an Owner, I want the system to automatically assign the best available employee to an approved job so that response times are minimized and workload is balanced.

#### Acceptance Criteria

1. WHEN a job's `approval_status` transitions to `approved`, THE Dispatch_Service SHALL evaluate all active employees in the same company and select the best candidate using a composite score.
2. THE Dispatch_Service SHALL compute the composite score for each candidate employee using the following weighted factors: proximity to the job location (nearest distance scores highest), active job count (fewest active jobs scores highest), and employee performance rating (highest rating scores highest).
3. WHEN the Dispatch_Service identifies a best-scoring employee, THE System SHALL assign that employee to the job, set `assigned_to` to the employee's `user_id`, and record `assigned_at` as the current UTC timestamp.
4. IF no eligible employee is found (all employees are unavailable or no employees exist), THEN THE Dispatch_Service SHALL leave the job unassigned and set a `dispatch_status` of `unassigned` on the job record.
5. WHEN Smart_Dispatch assigns an employee, THE Notification_Service SHALL send a notification to the assigned employee with the job title, priority, and job ID.
6. THE Dispatch_Service SHALL only consider employees whose `is_active` flag is `true` and who belong to the same `company_id` as the job.
7. THE Dispatch_Service SHALL NOT override a manual assignment made by an Owner or HR user after the job was approved.

---

### Requirement 6: Geofenced Arrival System

**User Story:** As a Customer, I want to be notified when the assigned employee arrives at my job location so that I know service has begun.

#### Acceptance Criteria

1. WHILE an employee has an accepted job with a defined job location, THE Geofence_Service SHALL continuously evaluate the employee's current GPS coordinates against the job's location.
2. WHEN the distance between the employee's current GPS coordinates and the job's location is less than or equal to 100 meters, THE Geofence_Service SHALL mark the job's `employee_status` as `arrived` and record an `arrived_at` timestamp.
3. WHEN the `arrived` status is recorded, THE Notification_Service SHALL send a notification to the Customer associated with the job, informing them that the employee has arrived.
4. THE Geofence_Service SHALL store the `arrived_at` timestamp on the job record.
5. IF the job does not have a defined location (latitude and longitude), THEN THE Geofence_Service SHALL skip geofence evaluation for that job.
6. THE Geofence_Service SHALL enforce `company_id` isolation, ensuring employee location data is only evaluated against jobs within the same company.
7. THE System SHALL NOT mark a job as `arrived` more than once; subsequent entries into the geofence radius SHALL be ignored if `arrived_at` is already set.

---

### Requirement 7: SLA System

**User Story:** As an Owner, I want to define SLA targets for job acceptance and completion so that I can monitor and enforce service quality standards.

#### Acceptance Criteria

1. THE System SHALL store a company-level SLA configuration record containing `max_accept_time` (in minutes) and `max_completion_time` (in minutes), scoped by `company_id`.
2. WHEN an Owner creates or updates the SLA configuration via the Owner_Portal, THE System SHALL persist the new values for the authenticated company.
3. THE SLA_Service SHALL track whether each job's `accepted_at` timestamp falls within `max_accept_time` minutes of `assigned_at`.
4. THE SLA_Service SHALL track whether each job's `completed_at` timestamp falls within `max_completion_time` minutes of `approved_at`.
5. WHEN an SLA breach is detected, THE SLA_Service SHALL record a breach event on the job record with the breach type (`accept_breach` or `completion_breach`) and the breach timestamp.
6. THE Owner_Portal dashboard SHALL display SLA compliance metrics including total jobs, breached jobs count, and breach percentage for the current company.
7. THE System SHALL enforce `company_id` isolation on all SLA configuration reads and writes.

---

### Requirement 8: Billing and Invoicing

**User Story:** As an Owner, I want an invoice to be automatically generated when a job is completed so that billing is consistent and timely.

#### Acceptance Criteria

1. WHEN a job's `status` transitions to `completed`, THE Billing_Service SHALL automatically generate an invoice record linked to the `job_id` and `company_id`.
2. THE invoice record SHALL include: labor hours (derived from `started_at` to `completed_at`), materials cost (sum of materials logged against the job), service charges (configurable per company), and a total amount.
3. THE Owner_Portal SHALL display a list of generated invoices filterable by date range, customer, and status (`draft`, `sent`, `paid`).
4. WHEN an invoice is generated, THE Notification_Service SHALL notify the Owner that a new invoice is available.
5. THE Billing_Service SHALL enforce `company_id` isolation, ensuring invoices are only accessible within the company that owns the job.
6. IF a job has no `started_at` timestamp, THEN THE Billing_Service SHALL set labor hours to zero and generate the invoice with available data.

---

### Requirement 9: Material Usage Tracking

**User Story:** As an Employee, I want to log materials I use on a job so that inventory is kept accurate and billing reflects actual material costs.

#### Acceptance Criteria

1. WHEN an Employee logs material usage against a job, THE System SHALL create a `job_materials` record linking `job_id`, `inventory_item_id`, `quantity_used`, `employee_id`, and `company_id`.
2. WHEN a `job_materials` record is created, THE System SHALL deduct `quantity_used` from the corresponding `inventory_items.quantity` for the same `company_id`.
3. IF the requested `quantity_used` exceeds the available `inventory_items.quantity`, THEN THE System SHALL reject the log request and return an error message indicating insufficient stock.
4. THE Owner_Portal and HR_Portal SHALL display material usage records grouped by job, showing item name, quantity used, and the employee who logged the usage.
5. THE System SHALL enforce `company_id` isolation on all material usage reads and writes.
6. WHEN material usage is logged, THE Audit_Service SHALL record the action with `user_id`, `job_id`, `item_id`, `quantity_used`, and timestamp.

---

### Requirement 10: Performance Analytics

**User Story:** As an Owner, I want to view performance analytics for employees so that I can identify top performers and address underperformance.

#### Acceptance Criteria

1. THE Analytics_Service SHALL compute the following metrics per employee per time period: total jobs completed, average response time (time from `assigned_at` to `accepted_at`), job completion rate (completed / assigned), and SLA compliance rate.
2. THE Owner_Portal analytics dashboard SHALL display these metrics in a tabular and graphical format, filterable by date range and employee.
3. THE Analytics_Service SHALL aggregate company-level metrics including total jobs, average completion time, and overall SLA compliance percentage.
4. WHEN the analytics dashboard is loaded, THE System SHALL return pre-computed or cached metrics to ensure the response time is within 3 seconds for datasets up to 10,000 jobs.
5. THE Analytics_Service SHALL enforce `company_id` isolation, ensuring metrics are computed only from jobs and employees within the authenticated company.

---

### Requirement 11: AI-Based Job Prioritization

**User Story:** As an Owner or Customer, I want the system to suggest a job priority based on the job description so that urgent jobs are not accidentally submitted with low priority.

#### Acceptance Criteria

1. WHEN a job is created with a description, THE AI_Prioritization_Service SHALL analyze the description text and assign a suggested priority of `high`, `medium`, or `low`.
2. THE AI_Prioritization_Service SHALL map keywords associated with urgency (such as "emergency", "urgent", "critical", "broken", "leak", "fire") to `high` priority.
3. THE AI_Prioritization_Service SHALL map keywords associated with routine work (such as "maintenance", "inspection", "scheduled", "routine") to `low` priority.
4. THE AI_Prioritization_Service SHALL default to `medium` priority when no strong keyword signal is detected.
5. WHEN a suggested priority is returned, THE System SHALL allow the submitting user (Owner, HR, or Customer) to manually override the suggested priority before saving.
6. THE AI_Prioritization_Service SHALL operate as a non-blocking suggestion; IF the service is unavailable, THEN THE System SHALL proceed with the user-provided or default priority without error.

---

### Requirement 12: Real-Time Push Notifications

**User Story:** As any portal user, I want to receive real-time browser notifications for key job lifecycle events so that I can respond promptly without polling.

#### Acceptance Criteria

1. THE Notification_Service SHALL send a browser push notification to the relevant Owner and HR users WHEN a Customer submits a new job.
2. THE Notification_Service SHALL send a browser push notification to the Customer WHEN their job's `approval_status` changes to `approved` or `rejected`.
3. THE Notification_Service SHALL send a browser push notification to the assigned Employee WHEN a job is assigned to them.
4. THE Notification_Service SHALL send a browser push notification to the Customer WHEN an Employee accepts their job.
5. THE Notification_Service SHALL send a browser push notification to the Owner and Customer WHEN a job's `status` transitions to `completed`.
6. THE Notification_Service SHALL deliver notifications scoped to the correct `company_id` and recipient `user_id` or `customer_id`, ensuring no cross-tenant notification leakage.
7. IF a user's browser push token is unavailable or expired, THEN THE Notification_Service SHALL fall back to storing the notification in the `notifications` table for in-app display without throwing an error.

---

### Requirement 13: Extended Role-Based Access Control (RBAC)

**User Story:** As an Owner, I want to assign granular roles to my team members so that each person has access only to the features relevant to their responsibilities.

#### Acceptance Criteria

1. THE System SHALL support the following roles: `owner`, `hr`, `manager`, `supervisor`, `employee`, `viewer`.
2. THE System SHALL enforce the following access rules: `owner` has full access; `hr` can manage jobs, employees, and leave requests; `manager` can approve jobs and view analytics; `supervisor` can assign jobs and view team performance; `employee` can view and update their own assigned jobs; `viewer` has read-only access to jobs and analytics.
3. WHEN a user attempts an action that exceeds their role's permissions, THE System SHALL return HTTP 403 with a descriptive error message.
4. THE Owner_Portal SHALL provide a role management interface where an Owner can assign or change roles for users within the same company.
5. THE System SHALL enforce `company_id` isolation on all role assignments, preventing cross-tenant role manipulation.
6. WHEN a role is changed for a user, THE Audit_Service SHALL record the action with the actor's `user_id`, the target `user_id`, the old role, the new role, and the timestamp.

---

### Requirement 14: Multi-Branch Support

**User Story:** As an Owner of a multi-location business, I want to assign employees, jobs, and inventory to specific branches so that operations are organized by location.

#### Acceptance Criteria

1. THE System SHALL store a `branches` table with fields: `id`, `company_id`, `name`, `address`, `latitude`, `longitude`, `created_at`.
2. THE System SHALL add a `branch_id` foreign key column to the `users`, `jobs`, and `inventory_items` tables.
3. WHEN an Owner creates or updates an employee, job, or inventory item, THE System SHALL allow optional assignment of a `branch_id` from the same company.
4. THE Owner_Portal SHALL provide a branch management interface where an Owner can create, update, and deactivate branches within their company.
5. THE System SHALL enforce `company_id` isolation on all branch reads and writes, ensuring branches are only accessible within the owning company.
6. WHEN filtering jobs or employees by branch, THE System SHALL return only records where `branch_id` matches the requested branch and `company_id` matches the authenticated company.

---

### Requirement 15: Audit Log System

**User Story:** As an Owner, I want a comprehensive audit log of all significant user actions so that I can investigate issues and maintain compliance.

#### Acceptance Criteria

1. THE System SHALL store audit log entries in a dedicated `audit_logs` table with fields: `id`, `company_id`, `user_id`, `actor_type` (`user` or `customer`), `action_type`, `entity_type`, `entity_id`, `old_value` (JSONB), `new_value` (JSONB), `ip_address`, `user_agent`, `created_at`.
2. THE Audit_Service SHALL record an entry for each of the following actions: job created, job approved, job rejected, job assigned, job completed, role changed, SLA config updated, invoice generated, material usage logged, branch created or updated, and company settings changed.
3. THE Owner_Portal SHALL provide an audit log viewer filterable by `action_type`, `user_id`, `entity_type`, and date range.
4. THE audit_logs table SHALL be append-only; THE System SHALL NOT permit UPDATE or DELETE operations on audit log records via the API.
5. THE System SHALL enforce `company_id` isolation on all audit log reads, ensuring owners can only view their own company's audit trail.
6. THE Audit_Service SHALL operate non-blocking; IF writing an audit log entry fails, THEN THE System SHALL log the error to the server console and continue the primary operation without returning an error to the client.

---

### Requirement 16: Offline Mode for Employees

**User Story:** As a field Employee, I want to accept and update jobs when I have no internet connection so that my work is not blocked by connectivity issues.

#### Acceptance Criteria

1. THE Employee_Portal SHALL cache the employee's assigned jobs locally using a service worker or IndexedDB when the device is online.
2. WHEN the Employee_Portal detects that the device is offline, THE System SHALL allow the employee to accept a job, update job progress, and log material usage using the locally cached data.
3. WHEN the Employee_Portal detects that the device has returned online, THE System SHALL automatically synchronize all pending offline actions to the backend in the order they were performed.
4. IF a synchronization conflict is detected (the job was modified server-side while the employee was offline), THEN THE System SHALL surface the conflict to the employee with the server-side and local values, allowing the employee to choose which value to keep.
5. THE Employee_Portal SHALL display a clear visual indicator when the device is operating in offline mode.
6. THE offline cache SHALL be scoped to the authenticated employee's `user_id` and `company_id`, preventing access to other employees' data.

---

### Requirement 17: Advanced Customer Features

**User Story:** As a Customer, I want to schedule jobs, set up recurring jobs, view my service history, and mark preferred employees so that I have greater control over my service experience.

#### Acceptance Criteria

1. WHEN a Customer creates a job, THE Customer_Portal SHALL allow the customer to specify a `scheduled_at` datetime for when the job should be performed.
2. THE Customer_Portal SHALL allow a Customer to configure a recurring job by specifying a recurrence pattern (`daily`, `weekly`, `monthly`) and an end date.
3. WHEN a recurring job's scheduled time arrives, THE System SHALL automatically create a new job record with the same title, description, priority, and customer association, and set its `approval_status` according to the company's `auto_approve_customer_jobs` setting.
4. THE Customer_Portal SHALL display a service history view listing all past completed jobs for the authenticated customer, including job title, completion date, assigned employee name, and invoice total.
5. THE Customer_Portal SHALL allow a Customer to mark an employee as a favorite by storing a `customer_favorite_employees` record linking `customer_id` and `user_id`.
6. WHERE a Customer has a favorite employee and that employee is available, THE Dispatch_Service SHALL give the favorite employee a priority boost in the composite scoring algorithm.

---

### Requirement 18: API Access with Token-Based Authentication

**User Story:** As a third-party developer or integration partner, I want to access SmartERP data via a documented API with token-based authentication so that I can build integrations.

#### Acceptance Criteria

1. THE System SHALL provide API access tokens that are scoped to a single `company_id` and generated by an Owner via the Owner_Portal.
2. WHEN an API request is received with a valid Bearer token, THE System SHALL authenticate the request and enforce the same `company_id` isolation as standard user sessions.
3. THE System SHALL enforce rate limiting on API token requests at a maximum of 1000 requests per hour per token.
4. WHEN an API token exceeds the rate limit, THE System SHALL return HTTP 429 with a `Retry-After` header indicating when the limit resets.
5. THE System SHALL allow an Owner to revoke an API token at any time via the Owner_Portal, immediately invalidating all subsequent requests using that token.
6. THE System SHALL log all API token usage to the Audit_Log with the token ID, endpoint accessed, HTTP method, and timestamp.

---

### Requirement 19: White-Label Branding

**User Story:** As an Owner, I want to customize the portal with my company's logo and brand colors so that the product feels native to my business.

#### Acceptance Criteria

1. THE System SHALL store white-label branding settings per company including: `logo_url`, `primary_color` (hex), `secondary_color` (hex), and `company_display_name`.
2. WHEN a Customer or Employee loads the portal, THE System SHALL apply the company's branding settings to the portal's visual theme.
3. THE Owner_Portal settings page SHALL provide an interface for uploading a logo and selecting brand colors.
4. WHEN a logo is uploaded, THE System SHALL validate that the file is an image type (PNG, JPG, SVG) and does not exceed 2MB in size.
5. IF branding settings are not configured for a company, THEN THE System SHALL display the default SmartERP branding without error.
6. WHERE a custom domain is configured for a company (future capability), THE System SHALL serve the branded portal on that domain.
