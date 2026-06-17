import "dotenv/config";

const apiKey = process.env.DEEPSEEK_API_KEY;

const samplePatch = `@@ -1,3 +1,6 @@
 function add(a, b) {
-  return a + b;
+  return a - b;
 }
+
+function unused() {}
`;

const response = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You are Codessa, an expert code reviewer. Respond ONLY with valid JSON: { "summary": string, "comments": [{ "file": string, "line": number | null, "severity": "info"|"minor"|"major"|"critical", "comment": string }] }`,
      },
      { role: "user", content: `Diff to review:\n### File: math.js\n${samplePatch}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  }),
});

console.log("STATUS:", response.status);
const data = await response.json();
console.log(JSON.stringify(data, null, 2));
