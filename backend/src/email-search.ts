
import { elasticsearchClient, EMAIL_INDEX } from "./elasticsearch";

export interface EmailSearchDocument {
  emailJobId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  createdAt: string;
}

export async function indexEmail(
  email: EmailSearchDocument
): Promise<void> {
  await elasticsearchClient.index({
    index: EMAIL_INDEX,
    id: email.emailJobId,
    document: email,
    refresh: "wait_for",
  });
}

export async function searchEmails(query: string) {
  const result = await elasticsearchClient.search({
    index: EMAIL_INDEX,
    query: {
      multi_match: {
        query,
        fields: [
          "recipientEmail",
          "subject",
          "body",
          "status",
        ],
      },
    },
  });

  return result.hits.hits.map((hit) => ({
    id: hit._id,
    ...((hit._source ?? {}) as EmailSearchDocument),
  }));
}
