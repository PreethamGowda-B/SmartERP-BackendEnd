'use strict';

const crypto = require('crypto');
const { normalizeConversationPage, getRetentionCutoff } = require('./aiConversationPolicy');

const MAX_DOCUMENT_VERSION = 2147483647;
const MAX_DOCUMENT_VERSION_ALLOCATION_ATTEMPTS = 100;

function safeTitle(value, fallback = 'New conversation') {
  const title = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (title || fallback).slice(0, 255);
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createAiPersistenceRepository({ pool, now = () => new Date() }) {
  if (!pool?.query || !pool?.connect) throw new TypeError('A PostgreSQL pool is required.');

  async function createConversation({ userId, companyId, title, retentionDays, requestKey = null }) {
    const normalizedTitle = safeTitle(title);
    const fingerprint = canonicalHash({ title: normalizedTitle });
    const retentionUntil = new Date(now().getTime() + Number(retentionDays) * 86400000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (requestKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`ai-conversation:${String(companyId)}:${String(userId)}`, requestKey]);
      if (requestKey) {
        const prior = await client.query(`SELECT id, creation_fingerprint FROM public.ai_conversations WHERE company_id=$1 AND owner_user_id=$2::uuid AND creation_key=$3 LIMIT 1`, [String(companyId), String(userId), requestKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].creation_fingerprint !== fingerprint) { const error = new Error('Idempotency key was already used with different conversation data.'); error.statusCode=409; error.code='AI_IDEMPOTENCY_CONFLICT'; throw error; }
          const existing = await client.query(`SELECT id, company_id, owner_user_id, title, created_at, updated_at, retention_until FROM public.ai_conversations WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid`, [prior.rows[0].id, String(companyId), String(userId)]);
          await client.query('COMMIT');
          return { ...existing.rows[0], replayed: true };
        }
      }
      const result = await client.query(
        `INSERT INTO public.ai_conversations (company_id, owner_user_id, creation_key, creation_fingerprint, title, retention_until)
         VALUES ($1,$2::uuid,$3,$4,$5,$6) RETURNING id, company_id, owner_user_id, title, created_at, updated_at, retention_until`,
        [String(companyId), String(userId), requestKey, requestKey ? fingerprint : null, normalizedTitle, retentionUntil]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function listConversations({ userId, companyId, page = 1, limit = 25, retentionDays }) {
    const paging = normalizeConversationPage({ page, limit });
    const cutoff = getRetentionCutoff({ now: now(), retentionDays });
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT id, title, created_at, updated_at
           FROM public.ai_conversations
          WHERE company_id=$1 AND owner_user_id=$2::uuid AND deleted_at IS NULL
            AND (retention_until IS NULL OR retention_until > now())
            AND created_at >= $3
          ORDER BY updated_at DESC, id DESC LIMIT $4 OFFSET $5`,
        [String(companyId), String(userId), cutoff, paging.limit, paging.offset]
      ),
      pool.query(
        `SELECT count(*)::int AS total FROM public.ai_conversations
          WHERE company_id=$1 AND owner_user_id=$2::uuid AND deleted_at IS NULL
            AND (retention_until IS NULL OR retention_until > now()) AND created_at >= $3`,
        [String(companyId), String(userId), cutoff]
      ),
    ]);
    return { items: items.rows, page: paging.page, limit: paging.limit, total: count.rows[0]?.total || 0 };
  }

  async function openConversation({ id, userId, companyId, page = 1, limit = 100, retentionDays }) {
    const paging = normalizeConversationPage({ page, limit });
    const cutoff = getRetentionCutoff({ now: now(), retentionDays });
    const conversation = await pool.query(
      `SELECT id, company_id, owner_user_id, title, created_at, updated_at
         FROM public.ai_conversations
        WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid
          AND deleted_at IS NULL AND (retention_until IS NULL OR retention_until > now())
          AND created_at >= $4 LIMIT 1`,
      [String(id), String(companyId), String(userId), cutoff]
    );
    if (!conversation.rows[0]) return null;
    const messages = await pool.query(
      `SELECT id, role, content, citations, response_metadata, request_key, created_at
         FROM public.ai_conversation_messages
        WHERE conversation_id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid
        ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [String(id), String(companyId), String(userId), paging.limit, paging.offset]
    );
    return { ...conversation.rows[0], messages: messages.rows.reverse(), page: paging.page, limit: paging.limit };
  }

  async function renameConversation({ id, userId, companyId, title }) {
    const result = await pool.query(
      `UPDATE public.ai_conversations SET title=$4, updated_at=now()
        WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid AND deleted_at IS NULL
        RETURNING id, title, updated_at`,
      [String(id), String(companyId), String(userId), safeTitle(title)]
    );
    return result.rows[0] || null;
  }

  async function deleteConversation({ id, userId, companyId }) {
    const result = await pool.query(
      `UPDATE public.ai_conversations SET deleted_at=now(), updated_at=now()
        WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid AND deleted_at IS NULL
        RETURNING id`,
      [String(id), String(companyId), String(userId)]
    );
    return Boolean(result.rows[0]);
  }

  async function appendMessage({ conversationId, userId, companyId, role, content, citations = [], responseMetadata = {}, requestKey = null }) {
    if (!['user', 'assistant'].includes(role)) throw new TypeError('Unsupported AI conversation message role.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT id FROM public.ai_conversations
          WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid AND deleted_at IS NULL
          FOR UPDATE`,
        [String(conversationId), String(companyId), String(userId)]
      );
      if (!owner.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const message = await client.query(
        `INSERT INTO public.ai_conversation_messages
           (conversation_id, company_id, owner_user_id, role, content, citations, response_metadata, request_key)
         VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6::jsonb,$7::jsonb,$8)
         RETURNING id, role, content, citations, response_metadata, request_key, created_at`,
        [String(conversationId), String(companyId), String(userId), role, String(content), JSON.stringify(citations), JSON.stringify(responseMetadata), requestKey]
      );
      await client.query('UPDATE public.ai_conversations SET updated_at=now() WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid', [String(conversationId), String(companyId), String(userId)]);
      await client.query('COMMIT');
      return message.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function beginTurn({ conversationId, userId, companyId, requestKey, fingerprint, content, retentionDays }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        `SELECT id FROM public.ai_conversations WHERE id=$1::uuid AND company_id=$2
          AND owner_user_id=$3::uuid AND deleted_at IS NULL
          AND (retention_until IS NULL OR retention_until > now()) FOR UPDATE`,
        [String(conversationId), String(companyId), String(userId)]
      );
      if (!conversation.rows[0]) { await client.query('ROLLBACK'); return { kind: 'not_found' }; }
      const priorMessages = await client.query(
        `SELECT role, content FROM public.ai_conversation_messages
          WHERE conversation_id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid
            AND role IN ('user','assistant')
          ORDER BY created_at DESC, id DESC LIMIT 10`,
        [String(conversationId), String(companyId), String(userId)]
      );
      const history = priorMessages.rows.reverse().map((message) => ({
        sender: message.role === 'user' ? 'user' : 'assistant',
        content: String(message.content || ''),
      }));
      const expiresAt = new Date(now().getTime() + Number(retentionDays) * 86400000);
      const inserted = await client.query(
        `INSERT INTO public.ai_conversation_messages
          (conversation_id, company_id, owner_user_id, role, content, request_key,
           request_fingerprint, request_state, response_metadata)
         VALUES ($1::uuid,$2,$3::uuid,'user',$4,$5,$6,'pending',jsonb_build_object('expiresAt',$7::text))
         ON CONFLICT (company_id, conversation_id, owner_user_id, request_key)
           WHERE role='user' AND request_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [String(conversationId), String(companyId), String(userId), String(content), requestKey, fingerprint, expiresAt]
      );
      if (inserted.rows[0]) {
        await client.query(`UPDATE public.ai_conversations SET
          title=CASE WHEN lower(title)='new conversation' THEN left($4,255) ELSE title END,
          updated_at=now() WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid`,
        [String(conversationId), String(companyId), String(userId), safeTitle(content)]);
        await client.query('COMMIT');
        return { kind: 'started', userMessageId: inserted.rows[0].id, history };
      }
      const prior = await client.query(
        `SELECT id, content, request_fingerprint, request_state FROM public.ai_conversation_messages
          WHERE conversation_id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid
            AND role='user' AND request_key=$4 FOR UPDATE`,
        [String(conversationId), String(companyId), String(userId), requestKey]
      );
      if (!prior.rows[0] || prior.rows[0].request_fingerprint !== fingerprint) {
        await client.query('ROLLBACK'); return { kind: 'conflict' };
      }
      if (prior.rows[0].request_state === 'complete') {
        const response = await client.query(
          `SELECT response_metadata FROM public.ai_conversation_messages
            WHERE conversation_id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid
              AND role='assistant' AND request_key=$4 ORDER BY created_at DESC LIMIT 1`,
          [String(conversationId), String(companyId), String(userId), requestKey]
        );
        await client.query('COMMIT');
        return response.rows[0]?.response_metadata?.apiResponse
          ? { kind: 'replay', response: response.rows[0].response_metadata.apiResponse }
          : { kind: 'conflict' };
      }
      await client.query('COMMIT');
      return { kind: prior.rows[0].request_state === 'failed' ? 'failed' : 'pending' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async function completeTurn({ conversationId, userId, companyId, requestKey, response }) {
    const encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new Error('AI response is too large to persist safely.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userMessage = await client.query(
        `SELECT id FROM public.ai_conversation_messages WHERE conversation_id=$1::uuid AND company_id=$2
          AND owner_user_id=$3::uuid AND role='user' AND request_key=$4 AND request_state='pending' FOR UPDATE`,
        [String(conversationId), String(companyId), String(userId), requestKey]
      );
      if (!userMessage.rows[0]) { await client.query('ROLLBACK'); return false; }
      const assistant = await client.query(
        `INSERT INTO public.ai_conversation_messages
          (conversation_id, company_id, owner_user_id, role, content, citations, response_metadata, request_key)
         VALUES ($1::uuid,$2,$3::uuid,'assistant',$4,$5::jsonb,$6::jsonb,$7) RETURNING id`,
        [String(conversationId), String(companyId), String(userId), String(response.text || ''), JSON.stringify(Array.isArray(response.citations) ? response.citations : []), JSON.stringify({ apiResponse: response }), requestKey]
      );
      await client.query(`UPDATE public.ai_conversation_messages SET request_state='complete', response_metadata='{}'::jsonb WHERE id=$1::uuid AND company_id=$2`, [String(userMessage.rows[0].id), String(companyId)]);
      await client.query('UPDATE public.ai_conversations SET updated_at=now() WHERE id=$1::uuid AND company_id=$2 AND owner_user_id=$3::uuid', [String(conversationId), String(companyId), String(userId)]);
      await client.query('COMMIT');
      return Boolean(assistant.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async function failTurn({ conversationId, userId, companyId, requestKey, code }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        `SELECT id FROM public.ai_conversation_messages WHERE conversation_id=$1::uuid AND company_id=$2
          AND owner_user_id=$3::uuid AND role='user' AND request_key=$4 AND request_state='pending' FOR UPDATE`,
        [String(conversationId), String(companyId), String(userId), requestKey]
      );
      if (pending.rows[0]) {
        await client.query(
          `INSERT INTO public.ai_conversation_messages
            (conversation_id,company_id,owner_user_id,role,content,response_metadata,request_key)
           VALUES ($1::uuid,$2,$3::uuid,'assistant',$4,$5::jsonb,$6)`,
          [String(conversationId), String(companyId), String(userId), 'The AI request could not be completed. Start a new message to retry safely.', JSON.stringify({ safeErrorCode: String(code || 'AI_REQUEST_FAILED').slice(0,64) }), requestKey]
        );
        await client.query(
          `UPDATE public.ai_conversation_messages SET request_state='failed', response_metadata='{}'::jsonb WHERE id=$1::uuid AND company_id=$2`,
          [String(pending.rows[0].id), String(companyId)]
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function searchDocuments({ companyId, query, limit = 5 }) {
    const safeLimit = Math.min(20, Math.max(1, Number.parseInt(limit, 10) || 5));
    const terms = String(query || '').trim().slice(0, 8000);
    if (!terms) return [];
    const result = await pool.query(
      `SELECT c.document_id AS "documentId", d.title AS "documentName", c.chunk_index AS ordinal,
              c.content, ts_rank_cd(c.search_vector, plainto_tsquery('simple', $2)) AS score
         FROM public.ai_document_chunks c
         JOIN public.ai_documents d ON d.id=c.document_id AND d.company_id=c.company_id
        WHERE c.company_id=$1 AND d.company_id=$1
          AND d.processing_status='ready' AND d.deleted_at IS NULL AND d.superseded_by IS NULL
          AND (d.retention_until IS NULL OR d.retention_until > now())
          AND c.search_vector @@ plainto_tsquery('simple', $2)
        ORDER BY score DESC, c.document_id, c.chunk_index LIMIT $3`,
      [String(companyId), terms, safeLimit]
    );
    return result.rows.map((row) => ({ ...row, citation: { documentId: row.documentId, documentName: row.documentName, chunkOrdinal: row.ordinal } }));
  }

  async function ingestDocument({ userId, companyId, title, fileName, mimeType, contentHash, ingestFingerprint, text, chunks, requestKey, familyId, retentionDays }) {
    let client = await pool.connect();
    let documentId;
    let insertedDocument;
    try {
      await client.query('BEGIN');
      if (requestKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`ai-ingest:${String(companyId)}:${String(userId)}`, requestKey]);
      if (requestKey) {
        const existing = await client.query(
          `SELECT id, ingest_fingerprint, processing_status FROM public.ai_documents
            WHERE company_id=$1 AND uploaded_by=$2::uuid AND ingest_request_key=$3 LIMIT 1`,
          [String(companyId), String(userId), requestKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].ingest_fingerprint !== ingestFingerprint) {
            const error = new Error('Idempotency key was already used with different document content.');
            error.statusCode = 409; error.code = 'AI_DOCUMENT_IDEMPOTENCY_CONFLICT'; throw error;
          }
          await client.query('COMMIT');
          return { ...existing.rows[0], replayed: true };
        }
      }
      const selectedFamily = familyId || crypto.randomUUID();
      const retentionUntil = new Date(now().getTime() + Number(retentionDays) * 86400000);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`ai-doc:${String(companyId)}`, selectedFamily]);
      const latest = await client.query(
        `SELECT id, version, deleted_at, superseded_by FROM public.ai_documents
          WHERE company_id=$1 AND document_family_id=$2::uuid
          ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [String(companyId), selectedFamily]
      );
      let version = Number(latest.rows[0]?.version || 0) + 1;
      let insertedDocumentResult;
      for (let attempt = 0; attempt < MAX_DOCUMENT_VERSION_ALLOCATION_ATTEMPTS && version <= MAX_DOCUMENT_VERSION; attempt += 1) {
        insertedDocumentResult = await client.query(
          `INSERT INTO public.ai_documents
          (company_id, uploaded_by, document_family_id, title, original_filename, media_type,
           processing_status, content_sha256, ingest_fingerprint, version, ingest_request_key, processing_attempts,
           processing_started_at, extracted_text, processed_at, retention_until)
         VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,'processing',$7,$8,$9,$10,1,now(),$11,NULL,$12)
         ON CONFLICT ON CONSTRAINT ai_documents_family_version_key DO NOTHING
         RETURNING id, company_id, document_family_id, title, original_filename, processing_status, content_sha256, version, created_at`,
          [String(companyId), String(userId), selectedFamily, safeTitle(title, fileName), String(fileName).slice(0, 255), String(mimeType).slice(0, 127), contentHash, ingestFingerprint, version, requestKey || null, text, retentionUntil]
        );
        if (insertedDocumentResult.rows[0]) break;
        version += 1;
      }
      if (!insertedDocumentResult?.rows[0]) {
        const exhaustedVersionSpace = version > MAX_DOCUMENT_VERSION;
        const error = new Error(exhaustedVersionSpace
          ? 'This document family has exhausted its supported version numbers.'
          : 'A new version could not be allocated for this document family.');
        error.statusCode = 409;
        error.code = exhaustedVersionSpace
          ? 'AI_DOCUMENT_VERSION_EXHAUSTED'
          : 'AI_DOCUMENT_VERSION_ALLOCATION_EXHAUSTED';
        throw error;
      }
      documentId = insertedDocumentResult.rows[0].id;
      insertedDocument = insertedDocumentResult.rows[0];
      await client.query('COMMIT');

      // Keep the processing row durable so a failed chunk write can be retried
      // by the authorized reindex endpoint without losing its source text.
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`ai-doc:${String(companyId)}`, String(insertedDocument.document_family_id)]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO public.ai_document_chunks(company_id, document_id, chunk_index, content, source_metadata)
           VALUES ($1,$2::uuid,$3,$4,$5::jsonb)`,
          [String(companyId), String(documentId), chunk.ordinal, chunk.content, JSON.stringify({ startOffset: chunk.startOffset, endOffset: chunk.endOffset })]
        );
      }
      const activeVersion = await client.query(`SELECT id, version FROM public.ai_documents WHERE company_id=$1 AND document_family_id=$2::uuid AND id<>$3::uuid AND deleted_at IS NULL AND superseded_by IS NULL AND processing_status='ready' ORDER BY version DESC LIMIT 1 FOR UPDATE`, [String(companyId), String(insertedDocument.document_family_id), String(documentId)]);
      const competing = activeVersion.rows[0];
      if (competing && Number(competing.version) > Number(insertedDocument.version)) {
        await client.query(
          'DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2',
          [String(documentId), String(companyId)]
        );
        await client.query(`UPDATE public.ai_documents SET superseded_by=$3::uuid, updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [String(documentId), String(companyId), String(competing.id)]);
      } else if (competing) {
        await client.query(
          'DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2',
          [String(competing.id), String(companyId)]
        );
        await client.query(`UPDATE public.ai_documents SET superseded_by=$3::uuid, updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [String(competing.id), String(companyId), String(documentId)]);
      }
      await client.query(`UPDATE public.ai_documents SET processing_status='ready', processed_at=now(), updated_at=now() WHERE id=$1::uuid AND company_id=$2`, [String(documentId), String(companyId)]);
      await client.query('COMMIT');
      return { ...insertedDocument, processing_status: 'ready' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (documentId) {
        await pool.query(`UPDATE public.ai_documents SET processing_status='failed', safe_error_code='INGEST_FAILED', updated_at=now() WHERE id=$1::uuid AND company_id=$2 AND uploaded_by=$3::uuid`, [String(documentId), String(companyId), String(userId)]).catch(() => {});
      }
      // An expired, deleted, or superseded row may be hidden by RLS while its
      // company/uploader-scoped idempotency key remains protected by the unique
      // index. Do not retry that key indefinitely or reveal the hidden row; map
      // only this known constraint to a generic, safe client conflict.
      if (error?.code === '23505' && error?.constraint === 'idx_ai_documents_ingest_request') {
        const conflict = new Error('This upload request key cannot be reused. Start a new upload request.');
        conflict.statusCode = 409;
        conflict.code = 'AI_DOCUMENT_IDEMPOTENCY_KEY_UNAVAILABLE';
        throw conflict;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function listDocuments({ companyId, page = 1, limit = 25 }) {
    const paging = normalizeConversationPage({ page, limit });
    const result = await pool.query(
      `SELECT id, document_family_id, title, original_filename, processing_status, content_sha256, version, created_at, updated_at
         FROM public.ai_documents WHERE company_id=$1 AND deleted_at IS NULL AND superseded_by IS NULL
           AND (retention_until IS NULL OR retention_until > now())
        ORDER BY updated_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [String(companyId), paging.limit, paging.offset]
    );
    return { items: result.rows, page: paging.page, limit: paging.limit };
  }

  async function deleteDocument({ id, companyId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT id FROM public.ai_documents WHERE id=$1::uuid AND company_id=$2
          AND deleted_at IS NULL AND superseded_by IS NULL
          AND (retention_until IS NULL OR retention_until > now()) FOR UPDATE`, [String(id), String(companyId)]
      );
      if (result.rows[0]) {
        // Delete chunks while the parent remains visible to the chunks' RLS policy.
        await client.query('DELETE FROM public.ai_document_chunks WHERE document_id=$1::uuid AND company_id=$2', [String(id), String(companyId)]);
        await client.query('UPDATE public.ai_documents SET deleted_at=now(), updated_at=now() WHERE id=$1::uuid AND company_id=$2', [String(id), String(companyId)]);
      }
      await client.query('COMMIT');
      return Boolean(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  return { createConversation, listConversations, openConversation, renameConversation, deleteConversation, appendMessage, beginTurn, completeTurn, failTurn, searchDocuments, ingestDocument, listDocuments, deleteDocument, canonicalHash };
}

module.exports = { createAiPersistenceRepository, canonicalHash, safeTitle };
