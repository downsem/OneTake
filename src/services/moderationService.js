import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

export async function reportResponse({ reporterUid, response, reason, action = 'report' }) {
  if (!reporterUid) throw new Error('Missing reporter.');
  if (!response?.id) throw new Error('Missing response.');

  return addDoc(collection(db, 'reports'), {
    type: 'response',
    action,
    reporterUid,
    reportedUid: response.uid || null,
    responseId: response.id,
    promptId: response.promptId || null,
    promptTextSnapshot: response.promptTextSnapshot || '',
    reason: reason || 'Other',
    status: 'pending',
    developerReviewRequired: true,
    reviewSlaHours: 24,
    createdAt: serverTimestamp(),
    createdAtClient: Date.now(),
    updatedAt: serverTimestamp(),
  });
}

export async function reportBlockedUser({ reporterUid, blockedUid, reason = 'Blocked abusive user', source = 'block' }) {
  if (!reporterUid) throw new Error('Missing reporter.');
  if (!blockedUid) throw new Error('Missing blocked user.');

  return addDoc(collection(db, 'reports'), {
    type: 'user_block',
    action: 'block',
    reporterUid,
    reportedUid: blockedUid,
    responseId: null,
    promptId: null,
    reason,
    source,
    status: 'pending',
    developerReviewRequired: true,
    reviewSlaHours: 24,
    createdAt: serverTimestamp(),
    createdAtClient: Date.now(),
    updatedAt: serverTimestamp(),
  });
}
