import { collection, doc, onSnapshot, query, runTransaction, where } from 'firebase/firestore';
import { db } from '../lib/firebase';

export const REACTION_TYPES = ['like', 'laugh', 'crazy', 'fire', 'respect'];

export function subscribeMyReactions(uid, onData, onError) {
  if (!uid) {
    onData({});
    return () => {};
  }

  return onSnapshot(
    query(collection(db, 'responseReactions'), where('uid', '==', uid)),
    (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        map[data.responseId] = data.type;
      });
      onData(map);
    },
    onError
  );
}

export async function toggleReaction({ responseId, uid, nextType }) {
  if (!REACTION_TYPES.includes(nextType)) throw new Error('Unknown reaction.');
  const reactionRef = doc(db, 'responseReactions', `${responseId}_${uid}`);
  const responseRef = doc(db, 'responses', responseId);

  await runTransaction(db, async (tx) => {
    const [reactionSnap, responseSnap] = await Promise.all([tx.get(reactionRef), tx.get(responseRef)]);
    if (!responseSnap.exists()) throw new Error('Response not found.');
    const responseData = responseSnap.data();
    const currentCounts = responseData.reactionCounts || {};

    if (reactionSnap.exists()) {
      const previousType = reactionSnap.data().type;
      if (previousType === nextType) {
        tx.delete(reactionRef);
        tx.update(responseRef, {
          reactionCounts: {
            ...currentCounts,
            [previousType]: Math.max((currentCounts[previousType] || 0) - 1, 0),
          },
        });
        return;
      }

      tx.set(
        reactionRef,
        {
          responseId,
          uid,
          type: nextType,
          updatedAtClient: Date.now(),
        },
        { merge: true }
      );
      tx.update(responseRef, {
        reactionCounts: {
          ...currentCounts,
          [previousType]: Math.max((currentCounts[previousType] || 0) - 1, 0),
          [nextType]: (currentCounts[nextType] || 0) + 1,
        },
      });
      return;
    }

    tx.set(reactionRef, {
      responseId,
      uid,
      type: nextType,
      createdAtClient: Date.now(),
      updatedAtClient: Date.now(),
    });
    tx.update(responseRef, {
      reactionCounts: {
        ...currentCounts,
        [nextType]: (currentCounts[nextType] || 0) + 1,
      },
    });
  });
}
