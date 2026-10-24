
import { Client } from "@elastic/elasticsearch";

const elasticsearchUrl =
  process.env.ELASTICSEARCH_URL || "http://localhost:9200";

const elasticsearchApiKey = process.env.ELASTICSEARCH_API_KEY;

export const elasticsearchClient = new Client({
  node: elasticsearchUrl,
  ...(elasticsearchApiKey
    ? {
        auth: {
          apiKey: elasticsearchApiKey,
        },
      }
    : {}),
});

export const EMAIL_INDEX = "emails";

export async function createEmailIndex() {
  const exists = await elasticsearchClient.indices.exists({
    index: EMAIL_INDEX,
  });

  if (!exists) {
    await elasticsearchClient.indices.create({
      index: EMAIL_INDEX,
      mappings: {
        properties: {
          emailJobId: { type: "keyword" },
          recipientEmail: { type: "keyword" },
          subject: { type: "text" },
          body: { type: "text" },
          status: { type: "keyword" },
          scheduledAt: { type: "date" },
          createdAt: { type: "date" },
        },
      },
    });
  }
}
