# OneTake rebuild notes

This rebuild replaces the old single-user demo flow with the core MVP product loops:

- profile setup with username + display name
- friends search / request / accept flow
- prompt inbox with hidden prompt preview
- commit -> reveal -> 10 second countdown -> record -> review -> submit/forfeit flow
- prompt-first feed with horizontal response rails
- 5 reaction types
- admin prompt template bank + issue-to-all flow
- prompt suggestions queue
- delete your own submitted responses

## Important manual steps

1. Deploy the updated Firestore rules in `firebase/firestore.rules`.
2. Deploy the updated Storage rules in `firebase/storage.rules`.
3. Make sure your Firebase project has the collections used by the app enabled through normal app writes.
4. Sign in with your account and use the **Enable admin tools (dev)** button on the profile tab if you want admin access immediately.
5. If Metro cache gets weird after replacing files, run:

```bash
npm install
npx expo start -c
```

## Known rough edges

- Save-to-Photos is not wired yet.
- Notifications UI is still not built out.
- Block/report flows are not wired in the UI yet.
- Upload retry is supported within the review state for the same recorded file, but there is not yet a persisted disk-backed recovery flow after full app restart.
