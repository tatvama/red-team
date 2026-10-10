# Models: choosing, serving and training

Tatvam works with any server that speaks the OpenAI chat completions API with streaming. How good the agent is depends mostly on the model. This guide explains what to look for and how to serve and customize it.

## What an agent model needs

1. **Reliable tool calling.** The model must emit well-formed function calls with valid JSON arguments. This matters more than raw benchmark scores.
2. **A long context window.** Coding tasks read many files. 32k tokens is the practical minimum; 64k to 128k is comfortable.
3. **Reasoning (optional but valuable).** Models that think before acting plan better. Tatvam displays their reasoning automatically.
4. **Coding skill**, if you want agentic coding.

## Picking a model

Open-weight models change quickly, so check current leaderboards for tool use (for example BFCL) and agentic coding (for example SWE-bench Verified) before you choose. Good families to evaluate:

| Hardware | Size class | Families to try |
| --- | --- | --- |
| Laptop CPU or small GPU (8–16 GB) | 4B–14B | Qwen3 small models, gpt-oss-20b (needs about 16 GB) |
| Single 24–48 GB GPU | 14B–32B, or MoE models with about 3B active | Qwen3 32B, Qwen3-Coder 30B-A3B, Devstral |
| One or more 80 GB+ GPUs (H100, H200, B200) | 70B–500B MoE | Qwen3-Coder large, gpt-oss-120b, GLM-4.x, DeepSeek V3.x, Kimi K2 |

Benchmark a shortlist on your own tasks. The mock server shows the event flow, but only a real model shows quality.

## Serving

### Ollama (simplest, single user)

```bash
ollama pull qwen3:8b
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

Ollama's OpenAI endpoint is `http://127.0.0.1:11434/v1`. Through that endpoint the context length cannot be set per request, so set it on the Ollama server and match `CONTEXT_TOKENS`.

### vLLM (GPU server, fast, many parallel requests)

```bash
vllm serve <model> \
  --api-key "$VLLM_API_KEY" \
  --max-model-len 65536 \
  --enable-auto-tool-choice \
  --tool-call-parser <parser> \
  --reasoning-parser <parser>
```

Pick `--tool-call-parser` and `--reasoning-parser` values for your model family from the vLLM documentation for the version you deploy (for example `hermes` or `qwen3_coder` for Qwen models, `deepseek_r1` or `qwen3` for reasoning). Without the tool flags the model replies in plain text and Tatvam falls back to chat without tools.

Check the endpoint before connecting Tatvam:

```bash
curl -H "Authorization: Bearer $VLLM_API_KEY" https://your-gpu-host/v1/models
```

### Network placement

- Never expose the model port publicly. Use TLS on a private network, a VPN or an SSH tunnel.
- Use `https://` in `GPU_BASE_URL`. Plain `http://` is accepted only for loopback (tunnels) or with `ALLOW_HTTP_MODEL_URLS=true` on a private network.

## "Training" your own agent

Training a frontier model from scratch costs far more than any single GPU server can provide. The practical path:

1. **Start from a strong open-weight model** that already calls tools well. Most of the capability comes from here.
2. **Shape behaviour without training** using custom instructions (Settings → Instructions), memories and the tool set. Try this first: it is free and instant.
3. **Fine-tune with LoRA or QLoRA** when you need a house style, domain knowledge or better tool use on your own tools. Common open-source trainers are Unsloth, Axolotl and Hugging Face TRL. A LoRA on a 7B–32B model fits on one large GPU.
   - Data: a few hundred to a few thousand high-quality conversations, including tool calls and tool results, in the same chat format the model was trained on.
   - Evaluate before and after on a fixed task set. Fine-tuning can quietly damage tool calling.
4. **Serve the result** with vLLM (merged weights, or the base model plus `--enable-lora`) and select it in Tatvam. The app does not change.

Conversations are stored in `DATA_DIR/tatvam.db`. Exporting reviewed conversations as fine-tuning data is on the roadmap.
