'use strict';

const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const { assertConversationOwner, getAuthenticatedIdentity } = require('../services/aiConversationPolicy');
const { assertDocumentAction } = require('../services/aiDocumentAccessPolicy');
const { prepareTextDocument, extractPlainText, chunkText } = require('../services/aiDocumentPipeline');
const { createAiPersistenceRepository, canonicalHash } = require('../services/aiPersistence');
const { aiPersistencePoliciesAreReady } = require('../services/aiPersistencePolicyReadiness');
const { pool } = require('../db');
const SecurityShield = require('../ai/gateway/security.shield');

const router = express.Router();
const repository = createAiPersistenceRepository({ pool });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config() {
  const conversationDays = Number(process.env.AI_CONVERSATION_RETENTION_DAYS);
  const documentDays = Number(process.env.AI_DOCUMENT_RETENTION_DAYS);
  const configured = process.env.AI_PERSISTENCE_ENABLED === 'true'
    && Number.isInteger(conversationDays) && conversationDays >= 1 && conversationDays <= 3650
    && Number.isInteger(documentDays) && documentDays >= 1 && documentDays <= 3650;
  return { configured, conversationDays, documentDays };
}

async function schemaIsReady(user, db = pool) {
  const companyId = String(user.companyId || user.company_id || '');
  const userId = String(user.id || user.userId || '');
  if (!companyId || !UUID_RE.test(userId)) return false;
  const result = await db.query(`
    SELECT current_user='smarterp_app' AS app_role,
      current_setting('app.current_user_id',true)=$1 AS user_context,
      current_setting('app.current_company_id',true)=$2 AS company_context,
      to_regclass('public.ai_documents') IS NOT NULL AS documents,
      to_regclass('public.ai_document_chunks') IS NOT NULL AS chunks,
      to_regclass('public.ai_conversations') IS NOT NULL AS conversations,
      to_regclass('public.ai_conversation_messages') IS NOT NULL AS messages,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.ai_documents')) AS documents_rls,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.ai_document_chunks')) AS chunks_rls,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.ai_conversations')) AS conversations_rls,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.ai_conversation_messages')) AS messages_rls,
      (SELECT count(*)=4 AND count(*) FILTER (WHERE policyname IN
        ('ai_documents_owner_scope','ai_document_chunks_owner_scope','ai_conversations_owner_scope','ai_conversation_messages_owner_scope'))=4
        FROM pg_policies WHERE schemaname='public' AND tablename IN
        ('ai_documents','ai_document_chunks','ai_conversations','ai_conversation_messages')) AS policies,
      COALESCE((SELECT json_agg(json_build_object(
        'tableName', tablename, 'policyName', policyname, 'permissive', permissive,
        'roles', roles, 'command', cmd, 'using', qual, 'withCheck', with_check
      ) ORDER BY tablename)
        FROM pg_policies
        WHERE schemaname='public' AND tablename IN
          ('ai_documents','ai_document_chunks','ai_conversations','ai_conversation_messages')), '[]'::json) AS ai_policies,
      (SELECT count(*)=2 FROM pg_indexes WHERE schemaname='public' AND indexname IN ('idx_ai_conversations_create_request_key','idx_ai_conversation_messages_user_request_key') AND lower(indexdef) LIKE '%create unique index%' AND lower(indexdef) LIKE '% where %') AS idempotency_indexes,
      (NOT EXISTS (SELECT 1 FROM (VALUES
        ('ai_documents','id','uuid'),('ai_documents','company_id','text'),('ai_documents','uploaded_by','uuid'),
        ('ai_documents','document_family_id','uuid'),('ai_documents','title','varchar'),('ai_documents','original_filename','varchar'),
        ('ai_documents','media_type','varchar'),('ai_documents','processing_status','varchar'),('ai_documents','content_sha256','bpchar'),
        ('ai_documents','ingest_fingerprint','bpchar'),('ai_documents','version','int4'),('ai_documents','ingest_request_key','varchar'),
        ('ai_documents','processing_attempts','int4'),('ai_documents','processing_started_at','timestamptz'),('ai_documents','processed_at','timestamptz'),
        ('ai_documents','extracted_text','text'),('ai_documents','safe_error_code','varchar'),('ai_documents','retention_until','timestamptz'),
        ('ai_documents','deleted_at','timestamptz'),('ai_documents','superseded_by','uuid'),('ai_documents','updated_at','timestamptz'),
        ('ai_document_chunks','document_id','uuid'),('ai_document_chunks','company_id','text'),('ai_document_chunks','chunk_index','int4'),
        ('ai_document_chunks','content','text'),('ai_document_chunks','search_vector','tsvector'),('ai_document_chunks','source_metadata','jsonb'),
        ('ai_conversations','id','uuid'),('ai_conversations','company_id','text'),('ai_conversations','owner_user_id','uuid'),
        ('ai_conversations','creation_key','varchar'),('ai_conversations','creation_fingerprint','bpchar'),
        ('ai_conversations','title','varchar'),('ai_conversations','retention_until','timestamptz'),('ai_conversations','deleted_at','timestamptz'),
        ('ai_conversations','updated_at','timestamptz'),('ai_conversation_messages','conversation_id','uuid'),
        ('ai_conversation_messages','company_id','text'),('ai_conversation_messages','owner_user_id','uuid'),
        ('ai_conversation_messages','role','varchar'),('ai_conversation_messages','content','text'),
        ('ai_conversation_messages','citations','jsonb'),('ai_conversation_messages','response_metadata','jsonb'),
        ('ai_conversation_messages','request_key','varchar'),('ai_conversation_messages','request_fingerprint','bpchar'),
        ('ai_conversation_messages','request_state','varchar')) expected(table_name,column_name,udt_name)
        LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=expected.table_name AND c.column_name=expected.column_name
        WHERE c.column_name IS NULL OR c.udt_name IS DISTINCT FROM expected.udt_name)) AS critical_columns,
      (has_table_privilege(current_user,'public.ai_documents','SELECT') AND has_table_privilege(current_user,'public.ai_documents','INSERT') AND has_table_privilege(current_user,'public.ai_documents','UPDATE')) AS documents_grants,
      (has_table_privilege(current_user,'public.ai_document_chunks','SELECT') AND has_table_privilege(current_user,'public.ai_document_chunks','INSERT') AND has_table_privilege(current_user,'public.ai_document_chunks','DELETE')) AS chunks_grants,
      (has_table_privilege(current_user,'public.ai_conversations','SELECT') AND has_table_privilege(current_user,'public.ai_conversations','INSERT') AND has_table_privilege(current_user,'public.ai_conversations','UPDATE')) AS conversations_grants,
      (has_table_privilege(current_user,'public.ai_conversation_messages','SELECT') AND has_table_privilege(current_user,'public.ai_conversation_messages','INSERT') AND has_table_privilege(current_user,'public.ai_conversation_messages','UPDATE')) AS messages_grants,
      (NOT has_table_privilege(current_user,'public.ai_documents','DELETE') AND NOT has_table_privilege(current_user,'public.ai_documents','TRUNCATE')
       AND NOT has_table_privilege(current_user,'public.ai_document_chunks','UPDATE') AND NOT has_table_privilege(current_user,'public.ai_document_chunks','TRUNCATE')
       AND NOT has_table_privilege(current_user,'public.ai_conversations','DELETE') AND NOT has_table_privilege(current_user,'public.ai_conversations','TRUNCATE')
       AND NOT has_table_privilege(current_user,'public.ai_conversation_messages','DELETE') AND NOT has_table_privilege(current_user,'public.ai_conversation_messages','TRUNCATE')) AS least_privilege`,
    [userId, companyId]
  );
  const row = result.rows[0] || {};
  return ['app_role','user_context','company_context','documents','chunks','conversations','messages','documents_rls','chunks_rls','conversations_rls','messages_rls','policies','idempotency_indexes','critical_columns','documents_grants','chunks_grants','conversations_grants','messages_grants','least_privilege'].every((key) => row[key] === true)
    && aiPersistencePoliciesAreReady(row.ai_policies);
}

function sendError(res, error) {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) console.error('[ai-persistence] operation failed', { code: error?.code || 'AI_PERSISTENCE_ERROR' });
  return res.status(status).json({ code: error?.code || 'AI_PERSISTENCE_ERROR', error: status >= 500 ? 'AI persistence is temporarily unavailable.' : error.message });
}

async function enabled(req, res, next) {
  const settings = config();
  if (!settings.configured) return res.status(503).json({ code: 'AI_PERSISTENCE_NOT_CONFIGURED', error: 'Server-backed AI storage is not enabled.' });
  try {
    if (!await schemaIsReady(req.user)) return res.status(503).json({ code: 'AI_PERSISTENCE_SCHEMA_NOT_READY', error: 'Server-backed AI storage is not ready.' });
    req.aiRetention = settings;
    return next();
  } catch (error) {
    console.error('[ai-persistence] schema readiness check failed', { code: error?.code || 'SCHEMA_CHECK_FAILED' });
    return res.status(503).json({ code: 'AI_PERSISTENCE_SCHEMA_NOT_READY', error: 'Server-backed AI storage is not ready.' });
  }
}

function identity(req) {
  return getAuthenticatedIdentity(req.user);
}
function requireUuidParam(req, res, next) {
  if (!UUID_RE.test(String(req.params.id || ''))) return res.status(400).json({ code: 'AI_RESOURCE_ID_INVALID', error: 'A valid resource ID is required.' });
  return next();
}
function handle(fn) {
  return async (req, res) => { try { await fn(req, res); } catch (error) { sendError(res, error); } };
}
function parseDocumentUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'AI_DOCUMENT_TOO_LARGE' : 'AI_DOCUMENT_UPLOAD_INVALID', error: tooLarge ? 'The document exceeds the 5 MB upload limit.' : 'The document upload could not be read.' });
  });
}

function createConversationTurnMiddleware({ repo = repository, ready = schemaIsReady, getConfig = config } = {}) {
  return async function persistConversationTurn(req, res, next) {
    if (!req.body?.conversationId) return next();
    const settings = getConfig();
    if (!settings.configured) return res.status(503).json({ code: 'AI_PERSISTENCE_NOT_CONFIGURED', error: 'Server-backed conversations are not enabled.' });
    const requestKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (requestKey.length < 8 || requestKey.length > 128) return res.status(400).json({ code: 'AI_IDEMPOTENCY_KEY_REQUIRED', error: 'A valid Idempotency-Key header is required for saved conversations.' });
    if (!UUID_RE.test(String(req.body.conversationId))) return res.status(400).json({ code: 'AI_CONVERSATION_ID_INVALID', error: 'A valid conversation ID is required.' });
    try {
      if (!await ready(req.user)) return res.status(503).json({ code: 'AI_PERSISTENCE_SCHEMA_NOT_READY', error: 'Server-backed conversations are not ready.' });
      const who = identity(req);
      const fingerprint = canonicalHash({
        message: String(req.sanitizedAiMessage || req.body.message || ''),
        modelScopes: Array.isArray(req.body.modelScopes) ? req.body.modelScopes : [],
        autoMode: req.body.autoMode !== false,
      });
      const turn = await repo.beginTurn({ conversationId: req.body.conversationId, ...who, requestKey, fingerprint, content: String(req.sanitizedAiMessage || req.body.message || ''), retentionDays: settings.conversationDays });
      if (turn.kind === 'not_found') return res.status(404).json({ code: 'AI_CONVERSATION_NOT_FOUND', error: 'Conversation not found.' });
      if (turn.kind === 'conflict') return res.status(409).json({ code: 'AI_IDEMPOTENCY_CONFLICT', error: 'This request key was already used for a different message.' });
      if (turn.kind === 'pending') return res.status(409).json({ code: 'AI_REQUEST_PENDING', error: 'This saved conversation request is still processing. Send a new request only after checking its status.' });
      if (turn.kind === 'failed') return res.status(409).json({ code: 'AI_REQUEST_FAILED_REPLAY', error: 'This saved conversation request failed. Start a new message to retry safely.' });
      if (turn.kind === 'replay') return res.status(200).json(turn.response);

      const persistedHistory = Array.isArray(turn.history) ? turn.history.slice(-10) : [];
      req.persistedConversationHistory = persistedHistory.flatMap((entry) => {
        if (!entry || !['user', 'assistant'].includes(entry.sender) || typeof entry.content !== 'string') return [];
        try {
          return [{ sender: entry.sender, content: SecurityShield.sanitizeInput(entry.content) }];
        } catch {
          // Previous conversation turns are untrusted context. Exclude a turn
          // rejected by the prompt guard instead of allowing it to alter policy.
          return [];
        }
      });

      const originalJson = res.json.bind(res);
      let completed = false;
      res.once('close', () => {
        if (!res.writableFinished && !completed) {
          completed = true;
          void repo.failTurn({ conversationId: req.body.conversationId, ...who, requestKey, code: 'AI_RESPONSE_CONNECTION_CLOSED' }).catch(() => {});
        }
      });
      res.json = (body) => {
        if (completed) return res;
        completed = true;
        res.json = originalJson;
        Promise.resolve().then(async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const saved = await repo.completeTurn({ conversationId: req.body.conversationId, ...who, requestKey, response: body || {} });
            if (!saved) throw new Error('AI conversation turn is no longer pending.');
          } else {
            await repo.failTurn({ conversationId: req.body.conversationId, ...who, requestKey, code: body?.code || `HTTP_${res.statusCode}` });
          }
          originalJson(body);
        }).catch((error) => {
          console.error('[ai-persistence] turn persistence failed', { code: error?.code || 'TURN_PERSISTENCE_FAILED' });
          void repo.failTurn({ conversationId: req.body.conversationId, ...who, requestKey, code: 'AI_PERSISTENCE_WRITE_FAILED' }).catch(() => {});
          res.statusCode = 503;
          originalJson({ code: 'AI_PERSISTENCE_WRITE_FAILED', error: 'The response could not be saved to this conversation. Please start a new message.' });
        });
        return res;
      };
      return next();
    } catch (error) {
      return sendError(res, error);
    }
  };
}

const protectedRoute = [authenticateToken, loadPlan, requireFeature('ai_assistant', 'AI assistant')];

router.get('/capabilities', ...protectedRoute, handle(async (req, res) => {
  const settings = config();
  let ready = false;
  if (settings.configured) {
    try { ready = await schemaIsReady(req.user); } catch { ready = false; }
  }
  const canManageDocuments = ['owner','admin'].includes(String(req.user.role || '').toLowerCase()) && Boolean(req.user.companyId || req.user.company_id);
  res.json({ conversations: ready, documents: ready && canManageDocuments, documentFormats: ['txt','md','markdown'], retrieval: 'keyword', semanticSearch: false });
}));

router.get('/conversations', ...protectedRoute, enabled, handle(async (req, res) => {
  const who = identity(req);
  res.json(await repository.listConversations({ ...who, page: req.query.page, limit: req.query.limit, retentionDays: req.aiRetention.conversationDays }));
}));

router.post('/conversations', ...protectedRoute, enabled, handle(async (req, res) => {
  const who = identity(req);
  const requestKey = String(req.get('Idempotency-Key') || '').trim();
  if (requestKey.length < 8 || requestKey.length > 128) return res.status(400).json({ code: 'AI_IDEMPOTENCY_KEY_REQUIRED', error: 'A valid Idempotency-Key header is required to create a saved conversation.' });
  const conversation = await repository.createConversation({ ...who, title: req.body?.title, retentionDays: req.aiRetention.conversationDays, requestKey });
  res.status(conversation.replayed ? 200 : 201).json({ conversation });
}));

router.get('/conversations/:id', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  const conversation = await repository.openConversation({ id: req.params.id, ...who, page: req.query.page, limit: req.query.limit, retentionDays: req.aiRetention.conversationDays });
  if (!conversation) return res.status(404).json({ code: 'AI_CONVERSATION_NOT_FOUND', error: 'Conversation not found.' });
  assertConversationOwner({ user: req.user, conversation });
  res.json({ conversation });
}));

router.patch('/conversations/:id', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  const conversation = await repository.renameConversation({ id: req.params.id, ...who, title: req.body?.title });
  if (!conversation) return res.status(404).json({ code: 'AI_CONVERSATION_NOT_FOUND', error: 'Conversation not found.' });
  res.json({ conversation });
}));

router.delete('/conversations/:id', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  const deleted = await repository.deleteConversation({ id: req.params.id, ...who });
  if (!deleted) return res.status(404).json({ code: 'AI_CONVERSATION_NOT_FOUND', error: 'Conversation not found.' });
  res.status(204).end();
}));

router.get('/documents', ...protectedRoute, enabled, handle(async (req, res) => {
  const who = identity(req);
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'list' });
  res.json(await repository.listDocuments({ companyId: who.companyId, page: req.query.page, limit: req.query.limit }));
}));

router.post('/documents', ...protectedRoute, (req, res, next) => {
  try { const who = identity(req); assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'upload' }); next(); }
  catch (error) { sendError(res, error); }
}, enabled, parseDocumentUpload, handle(async (req, res) => {
  const who = identity(req);
  if (!req.file) return res.status(400).json({ code: 'AI_DOCUMENT_FILE_REQUIRED', error: 'Upload a TXT or Markdown file.' });
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return res.status(400).json({ code: 'AI_DOCUMENT_IDEMPOTENCY_KEY_REQUIRED', error: 'A valid Idempotency-Key header is required.' });
  const familyId = UUID_RE.test(String(req.body?.documentFamilyId || '')) ? req.body.documentFamilyId : null;
  const title = String(req.body?.title || req.file.originalname).slice(0, 255);
  const prepared = prepareTextDocument({ buffer: req.file.buffer, fileName: req.file.originalname, mimeType: req.file.mimetype, companyId: who.companyId, uploadedBy: who.userId });
  const extractedText = extractPlainText({ buffer: req.file.buffer, fileName: req.file.originalname, mimeType: req.file.mimetype });
  const document = await repository.ingestDocument({
    ...who,
    title,
    fileName: prepared.fileName,
    mimeType: prepared.mimeType,
    contentHash: prepared.contentHash,
    text: extractedText,
    chunks: prepared.chunks,
    requestKey: idempotencyKey,
    familyId,
    retentionDays: req.aiRetention.documentDays,
    ingestFingerprint: canonicalHash({ contentHash: prepared.contentHash, title, fileName: prepared.fileName, mimeType: prepared.mimeType, familyId }),
  });
  res.status(document.replayed ? 200 : 201).json({ document });
}));

router.post('/documents/search', ...protectedRoute, enabled, handle(async (req, res) => {
  const who = identity(req);
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'search' });
  const results = await repository.searchDocuments({ companyId: who.companyId, query: req.body?.query, limit: req.body?.limit });
  res.json({ results, mode: 'keyword', semanticSearch: false });
}));

router.get('/documents/:id', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'download' });
  const result = await pool.query(`SELECT id, company_id AS "companyId", deleted_at AS "deletedAt", superseded_by AS "supersededBy", extracted_text, title FROM public.ai_documents WHERE id=$1::uuid AND company_id=$2 AND deleted_at IS NULL AND superseded_by IS NULL AND (retention_until IS NULL OR retention_until > now()) LIMIT 1`, [req.params.id, who.companyId]);
  const doc = result.rows[0];
  if (!doc) return res.status(404).json({ code: 'AI_DOCUMENT_NOT_FOUND', error: 'Document not found.' });
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'download', document: doc });
  res.json({ document: { id: doc.id, title: doc.title, text: doc.extracted_text } });
}));

router.post('/documents/:id/reindex', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  const result = await pool.query(`SELECT id, company_id AS "companyId", document_family_id, version, deleted_at AS "deletedAt", superseded_by AS "supersededBy", extracted_text, title FROM public.ai_documents WHERE id=$1::uuid AND company_id=$2 AND deleted_at IS NULL AND superseded_by IS NULL AND (retention_until IS NULL OR retention_until > now()) LIMIT 1`, [req.params.id, who.companyId]);
  const document = result.rows[0];
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'reindex', document });
  const chunks = chunkText(document.extracted_text || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`ai-doc:${who.companyId}`, String(document.document_family_id)]);
    await client.query(`UPDATE public.ai_documents SET processing_status='processing', processing_attempts=processing_attempts+1, processing_started_at=now(), updated_at=now() WHERE id=$1::uuid AND company_id=$2 AND deleted_at IS NULL AND superseded_by IS NULL`, [document.id, who.companyId]);
    await client.query('DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2', [document.id, who.companyId]);
    for (const chunk of chunks) await client.query(`INSERT INTO public.ai_document_chunks(company_id,document_id,chunk_index,content,source_metadata) VALUES($1,$2::uuid,$3,$4,$5::jsonb)`, [who.companyId, document.id, chunk.ordinal, chunk.content, JSON.stringify({ startOffset: chunk.startOffset, endOffset: chunk.endOffset })]);
    const active = await client.query(`SELECT id,version FROM public.ai_documents WHERE company_id=$1 AND document_family_id=$2::uuid AND id<>$3::uuid AND deleted_at IS NULL AND superseded_by IS NULL AND processing_status='ready' ORDER BY version DESC LIMIT 1 FOR UPDATE`, [who.companyId, document.document_family_id, document.id]);
    if (active.rows[0] && Number(active.rows[0].version) > Number(document.version)) {
      await client.query('DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2', [document.id, who.companyId]);
      await client.query(`UPDATE public.ai_documents SET superseded_by=$3::uuid,updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [document.id, who.companyId, active.rows[0].id]);
    } else if (active.rows[0]) {
      await client.query('DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2', [active.rows[0].id, who.companyId]);
      await client.query(`UPDATE public.ai_documents SET superseded_by=$3::uuid,updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [active.rows[0].id, who.companyId, document.id]);
    }
    await client.query(`UPDATE public.ai_documents SET processing_status='ready', processed_at=now(), safe_error_code=NULL, updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [document.id, who.companyId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  res.json({ document: { id: document.id, processing_status: 'ready', chunks: chunks.length } });
}));

router.delete('/documents/:id', ...protectedRoute, requireUuidParam, enabled, handle(async (req, res) => {
  const who = identity(req);
  const result = await pool.query(`SELECT id, company_id AS "companyId", deleted_at AS "deletedAt", superseded_by AS "supersededBy" FROM public.ai_documents WHERE id=$1::uuid AND company_id=$2 AND deleted_at IS NULL AND superseded_by IS NULL AND (retention_until IS NULL OR retention_until > now()) LIMIT 1`, [req.params.id, who.companyId]);
  assertDocumentAction({ user: req.user, companyId: who.companyId, action: 'delete', document: result.rows[0] });
  if (!await repository.deleteDocument({ id: req.params.id, companyId: who.companyId })) return res.status(404).json({ code: 'AI_DOCUMENT_NOT_FOUND', error: 'Document not found.' });
  res.status(204).end();
}));

router.aiPersistenceInternals = { schemaIsReady, config, repository, canonicalHash, createConversationTurnMiddleware };

module.exports = router;
