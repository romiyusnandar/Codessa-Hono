import { MongoClient } from "mongodb";
import type { Review, Repository, User } from "./models.js";

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017");

let connected = false;

export async function connectMongo() {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client;
}

const dbName = process.env.MONGODB_DB ?? "codessa";
const mongoDb = client.db(dbName);

export const collections = {
  users: mongoDb.collection<User>("users"),
  repositories: mongoDb.collection<Repository>("repositories"),
  reviews: mongoDb.collection<Review>("reviews"),
};
