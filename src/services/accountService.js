import { httpsCallable } from 'firebase/functions';
import { functions } from '../lib/firebase';

export async function deleteMyAccount() {
  const callable = httpsCallable(functions, 'deleteMyAccount');
  const result = await callable({});
  return result.data;
}
