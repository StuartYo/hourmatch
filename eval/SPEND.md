# Model spend log

2026-10-14, all on the owner's PublicAI key that belongs to Hack Apertus (should not have been used; stopped).
- Probes: 5 tiny calls (2 returned HTTP 429, 3 answered, under 100 tokens total).
- First dev run on swiss-ai/apertus-70b-instruct: no results written; attempts were rejected with HTTP 429 (count not logged, up to 36 x 3).
- Dev eval (aisingapore/Qwen-SEA-LION-v4-32B-IT): 36 calls. Held-out eval: 16 calls.
- Estimated tokens for the 52 successful eval calls: about 77,000 input (270,496 prompt characters / 3.5) and at most 26,000 output (max_tokens caps). Exact usage was not logged.
Since then: dry mode. Live calls need a dedicated LLM_API_KEY and HOURMATCH_LLM_LIVE=1.
