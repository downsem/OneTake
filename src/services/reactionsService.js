import {
  doc,
  getDoc,
  increment,
  onSnapshot,
  query,
  collection,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  deleteDoc,
  runTransaction,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export const REACTION_TYPES = ['like', 'laugh', 'crazy', 'fire', 'respect'];

function reactionIdFor(responseId, uid) {
  return `${responseId}_${uid}`;
}

export function subscribeMyReactions(uid, onData, onError) {
  const q = query(collection(db, 'responseReactions'), where('uid', '==', uid));

  return onSnapshot(
    q,
    (snap) => {
      const map = {};
      snap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.responseId && data.type) map[data.responseId] = data.type;
      });
      onData(map);
    },
    onError
  );
}

export async function toggleReaction({ responseId, uid, nextType }) {
  if (!responseId) throw new Error('Missing response id.');
  if (!uid) throw new Error('Missing user id.');
  if (!REACTION_TYPES.includes(nextType)) throw new Error('Invalid reaction type.');

  const reactionRef = doc(db, 'responseReactions', reactionIdFor(responseId, uid));
  const responseRef = doc(db, 'responses', responseId);

  await runTransaction(db, async (tx) => {
    const reactionSnap = await tx.get(reactionRef);
    const currentType = reactionSnap.exists() ? reactionSnap.data()?.type : null;

    if (currentType === nextType) {
      tx.delete(reactionRef);
      tx.update(responseRef, {
        [`reactionCounts.${currentType}`]: increment(-1),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    if (currentType) {
      tx.update(responseRef, {
        [`reactionCounts.${currentType}`]: increment(-1),
        [`reactionCounts.${nextType}`]: increment(1),
        updatedAt: serverTimestamp(),
      });
    } else {
      tx.update(responseRef, {
        [`reactionCounts.${nextType}`]: increment(1),
        updatedAt: serverTimestamp(),
      });
    }

    tx.set(
      reactionRef,
      {
        responseId,
        uid,
        type: nextType,
        updatedAt: serverTimestamp(),
        createdAtClient: Date.now(),
      },
      { merge: true }
    );
  });
}
