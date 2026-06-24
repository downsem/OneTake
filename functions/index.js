const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const storage = admin.storage();
const FieldValue = admin.firestore.FieldValue;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function commitInChunks(refs, operation) {
  const batches = chunk(refs, 400);
  for (const group of batches) {
    const batch = db.batch();
    group.forEach((ref) => operation(batch, ref));
    await batch.commit();
  }
}

async function deleteQuerySnapshot(snapshot) {
  if (snapshot.empty) return 0;
  await commitInChunks(snapshot.docs.map((doc) => doc.ref), (batch, ref) => batch.delete(ref));
  return snapshot.size;
}

async function isAdmin(uid) {
  if (!uid) return false;
  const userSnap = await db.collection('users').doc(uid).get();
  return userSnap.exists && userSnap.data()?.role === 'admin';
}

async function sendExpoPushMessages(items) {
  const batches = chunk(items, 100);
  const results = [];

  for (const batch of batches) {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch.map((item) => item.message)),
    });

    const body = await response.json().catch(() => null);
    const tickets = Array.isArray(body?.data) ? body.data : [];

    batch.forEach((item, index) => {
      results.push({
        item,
        ok: response.ok,
        httpStatus: response.status,
        ticket: tickets[index] || null,
        rawBody: tickets[index] ? null : body,
      });
    });
  }

  return results;
}

async function writePushLog(payload) {
  await db.collection('pushLogs').add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    createdAtClient: Date.now(),
  });
}

exports.sendNewPromptPush = onDocumentUpdated('prompts/{promptId}', async (event) => {
  const promptId = event.params.promptId;
  const before = event.data?.before?.data() || null;
  const prompt = event.data?.after?.data() || null;

  if (!prompt || prompt.status !== 'active' || before?.status === 'active' || prompt.pushSentAt) {
    logger.info('Skipping prompt push', { promptId, beforeStatus: before?.status, afterStatus: prompt?.status });
    return;
  }

  const recipientsSnap = await db
    .collection('promptRecipients')
    .where('promptId', '==', promptId)
    .get();

  const recipientUids = new Set(recipientsSnap.docs.map((doc) => doc.data()?.uid).filter(Boolean));

  if (!recipientUids.size) {
    logger.warn('No prompt recipients found for active prompt', { promptId });
    await writePushLog({ promptId, status: 'no_recipients', tokenCount: 0 });
    return;
  }

  const tokensSnap = await db
    .collection('pushTokens')
    .where('isActive', '==', true)
    .get();

  const tokenDocs = tokensSnap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .filter(
      (item) =>
        recipientUids.has(item.uid) &&
        typeof item.token === 'string' &&
        item.token.startsWith('ExponentPushToken')
    );

  if (!tokenDocs.length) {
    logger.info('No active Expo push tokens found for prompt recipients', { promptId });
    await writePushLog({
      promptId,
      status: 'no_tokens',
      recipientCount: recipientUids.size,
      tokenCount: 0,
    });
    return;
  }

  const now = Date.now();
  const deliveryRefs = tokenDocs.map(() => db.collection('notificationDeliveries').doc());
  const queuedBatch = db.batch();

  const items = tokenDocs.map((tokenDoc, index) => {
    const deliveryRef = deliveryRefs[index];
    const deliveryId = deliveryRef.id;

    queuedBatch.set(deliveryRef, {
      deliveryId,
      promptId,
      uid: tokenDoc.uid,
      tokenId: tokenDoc.id,
      token: tokenDoc.token,
      platform: tokenDoc.platform || null,
      status: 'queued',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdAtClient: now,
    });

    return {
      deliveryRef,
      tokenRef: tokenDoc.ref,
      uid: tokenDoc.uid,
      token: tokenDoc.token,
      message: {
        to: tokenDoc.token,
        sound: 'default',
        title: 'OneTake',
        body: 'New OneTake ready. Answer to unlock the reveal.',
        data: {
          type: 'new_prompt',
          promptId,
          deliveryId,
        },
      },
    };
  });

  await queuedBatch.commit();

  const results = await sendExpoPushMessages(items);
  const resultBatches = chunk(results, 400);

  for (const resultBatch of resultBatches) {
    const batch = db.batch();

    resultBatch.forEach(({ item, ok, httpStatus, ticket, rawBody }) => {
      const ticketStatus = ticket?.status || (ok ? 'unknown' : 'http_error');
      const ticketError = ticket?.details?.error || ticket?.message || null;

      batch.update(item.deliveryRef, {
        status: ticketStatus === 'ok' ? 'sent' : 'error',
        httpStatus,
        ticketId: ticket?.id || null,
        ticketStatus,
        ticketError,
        rawBody: rawBody || null,
        sentAt: FieldValue.serverTimestamp(),
        sentAtClient: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (ticket?.details?.error === 'DeviceNotRegistered') {
        batch.update(item.tokenRef, {
          isActive: false,
          deactivatedReason: 'DeviceNotRegistered',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    await batch.commit();
  }

  await db.collection('prompts').doc(promptId).update({
    pushSentAt: FieldValue.serverTimestamp(),
    pushSentAtClient: Date.now(),
    pushRecipientCount: recipientUids.size,
    pushTokenCount: tokenDocs.length,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writePushLog({
    promptId,
    status: 'sent',
    recipientCount: recipientUids.size,
    tokenCount: tokenDocs.length,
    okCount: results.filter((result) => result.ticket?.status === 'ok').length,
    errorCount: results.filter((result) => result.ticket?.status && result.ticket.status !== 'ok').length,
  });

  logger.info('Sent prompt push', { promptId, tokenCount: tokenDocs.length });
});

exports.deleteResponse = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to delete a response.');
  }

  const responseId = request.data?.responseId;
  if (!responseId || typeof responseId !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing response id.');
  }

  const responseRef = db.collection('responses').doc(responseId);
  const responseSnap = await responseRef.get();

  if (!responseSnap.exists) {
    return { ok: true, alreadyDeleted: true };
  }

  const response = responseSnap.data();
  const adminUser = await isAdmin(uid);

  if (response.uid !== uid && !adminUser) {
    throw new HttpsError('permission-denied', 'You can only delete your own response.');
  }

  if (response.storagePath) {
    try {
      await storage.bucket().file(response.storagePath).delete({ ignoreNotFound: true });
    } catch (error) {
      logger.warn('Failed to delete response storage file', {
        uid,
        responseId,
        path: response.storagePath,
        error: error.message,
      });
    }
  }

  await responseRef.update({
    status: 'deleted',
    videoUrl: '',
    storagePath: '',
    deletedAt: FieldValue.serverTimestamp(),
    deletedAtClient: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await deleteQuerySnapshot(await db.collection('responseReactions').where('responseId', '==', responseId).get());

  if (response.status === 'ready' && response.uid) {
    await db.collection('users').doc(response.uid).set(
      {
        responseCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  logger.info('Deleted response', { uid, responseId });
  return { ok: true };
});

exports.deleteMyAccount = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to delete your account.');
  }

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const usernameLower = userData && userData.usernameLower;

  const responsesSnap = await db.collection('responses').where('uid', '==', uid).get();
  const storagePaths = responsesSnap.docs
    .map((doc) => doc.data().storagePath)
    .filter((path) => typeof path === 'string' && path.length > 0);

  for (const path of storagePaths) {
    try {
      await storage.bucket().file(path).delete({ ignoreNotFound: true });
    } catch (error) {
      logger.warn('Failed to delete response storage file', { uid, path, error: error.message });
    }
  }

  await deleteQuerySnapshot(responsesSnap);
  await deleteQuerySnapshot(await db.collection('promptRecipients').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('responseReactions').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('notifications').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('pushTokens').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('notificationDeliveries').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('promptSuggestions').where('submittedByUid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('analyticsEvents').where('uid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('friendRequests').where('fromUid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('friendRequests').where('toUid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('friendships').where('users', 'array-contains', uid).get());
  await deleteQuerySnapshot(await db.collection('blocks').where('blockerUid', '==', uid).get());
  await deleteQuerySnapshot(await db.collection('blocks').where('blockedUid', '==', uid).get());

  if (usernameLower) {
    await db.collection('usernames').doc(usernameLower).delete().catch(() => null);
  }

  await userRef.delete().catch(() => null);
  await admin.auth().deleteUser(uid).catch((error) => {
    logger.warn('Failed to delete auth user', { uid, error: error.message });
  });

  logger.info('Deleted user account', { uid });
  return { ok: true };
});
