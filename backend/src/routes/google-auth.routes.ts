
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";

const router = Router();

const clientId = process.env.GOOGLE_CLIENT_ID;

if (!clientId) {
  console.warn("GOOGLE_CLIENT_ID is not configured. Google login will not work.");
}

const googleClient = new OAuth2Client(clientId);

router.post("/verify", async (req, res) => {
  try {
    const { credential } = req.body as { credential?: string };

    if (!credential || !clientId) {
      return res.status(400).json({
        message: "Google credential or server configuration is missing.",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });

    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email || !payload.email_verified) {
      return res.status(401).json({
        message: "Google account could not be verified.",
      });
    }

    return res.json({
      user: {
        id: payload.sub,
        name: payload.name ?? payload.email.split("@")[0],
        email: payload.email,
        picture: payload.picture ?? null,
      },
    });
  } catch (error) {
    console.error("Google token verification failed:", error);
    return res.status(401).json({
      message: "Google sign-in verification failed.",
    });
  }
});

export default router;
