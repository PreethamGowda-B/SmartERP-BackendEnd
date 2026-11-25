-- ============================================================================
-- Rollback for Migration 053: Recreate the 20 dropped duplicate indexes
-- ============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_attendance_clock_in ON public.attendance USING btree (check_in_time);
CREATE INDEX IF NOT EXISTS idx_attendance_company_date ON public.attendance USING btree (company_id, date);
CREATE INDEX IF NOT EXISTS idx_corrections_attendance ON public.attendance_corrections USING btree (attendance_id);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON public.attendance_corrections USING btree (status);
CREATE INDEX IF NOT EXISTS idx_corrections_user ON public.attendance_corrections USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_employee_profiles_user ON public.employee_profiles USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_company ON public.inventory_items USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON public.invoices USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON public.invoices USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job_id ON public.invoices USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_action_requests_company ON public.job_action_requests USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_job_action_requests_job ON public.job_action_requests USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_materials_company_id ON public.material_requests USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_materials_requested_by ON public.material_requests USING btree (requested_by);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON public.messages USING btree (receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON public.messages USING btree (sender_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company ON public.notifications USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id_read ON public.notifications USING btree (user_id, read);
CREATE INDEX IF NOT EXISTS idx_sub_events_company ON public.subscription_events USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_users_company ON public.users USING btree (company_id);

COMMIT;
