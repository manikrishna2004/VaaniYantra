// Firebase Admin SDK (server only). Authenticates via Application Default
// Credentials — on the VM this is the attached service account, so there is no
// key file to manage. For local dev, run `gcloud auth application-default login`.
import {
  initializeApp,
  getApps,
  getApp,
  applicationDefault,
  type App,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

export const adminApp: App = getApps().length
  ? getApp()
  : initializeApp({ credential: applicationDefault(), projectId });

export const adminAuth: Auth = getAuth(adminApp);
