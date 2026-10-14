import { buildDemoSeedDocuments } from "./seed-fixtures.ts";
import { filterSeedDocuments, parseSeedStage } from "./seed-stage.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST is required");
if (process.env.NODE_ENV === "production") throw new Error("seed-demo must not run in production");

const stage = parseSeedStage(process.argv.slice(2));
const selectedDocs = filterSeedDocuments(buildDemoSeedDocuments(), stage);
const { getApps, initializeApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");
if (!getApps().length) initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID ?? "rulebranch-demo" });
const db = getFirestore();
await Promise.all(selectedDocs.map(([collection, id, data]) => db.collection(collection).doc(id).set(data)));
console.log(`Demo seed completed (${selectedDocs.length} documents${stage ? ` through stage ${stage}` : ""})`);
