import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

export const ONETAKE_TERMS_VERSION = '1.0';

export async function acceptLatestTerms(uid) {
  if (!uid) throw new Error('Missing user id.');

  await updateDoc(doc(db, 'users', uid), {
    acceptedTermsVersion: ONETAKE_TERMS_VERSION,
    acceptedTermsAt: serverTimestamp(),
    acceptedTermsAtClient: Date.now(),
    communityGuidelinesAccepted: true,
    updatedAt: serverTimestamp(),
  });
}
