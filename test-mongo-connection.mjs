import "dotenv/config";
import { MongoClient } from "mongodb";
import dns from "dns";

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  await client.db(process.env.MONGODB_DB).command({ ping: 1 });
  console.log("CONNECTION_OK");
} catch (e) {
  console.log("CONNECTION_FAILED:", e.message);
} finally {
  await client.close();
}
