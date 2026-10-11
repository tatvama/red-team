# Training your own model

Tatvam can turn the way you already use it into a better model for your work. The loop is:

1. **Collect** feedback and corrections while you work.
2. **Review** conversations and approve the good ones.
3. **Export** a dataset.
4. **Measure a baseline** with the evaluation suite.
5. **Distill** extra examples from a larger teacher model (optional).
6. **Generate a kit** and **fine-tune** on your GPU server.
7. **Merge and serve** the result with vLLM.
8. **Register** the new model.
9. **Evaluate** the candidate against the baseline.
10. **Canary** it through the router, then **promote or retire** it.

Everything except the training run happens in Tatvam, on the **Training** page (`/training`). The
training run happens on a GPU server you control, using a kit folder Tatvam generates. Tatvam never
starts training jobs or contacts the GPU server for you, apart from calling the model you serve.

Expect the first round to take a day or two of calendar time, most of it collecting and reviewing
conversations. Later rounds are faster: the review queue, eval suite and kit settings carry over.

## Before you start

- Try the cheap options first. Custom instructions (Settings → Instructions), memories and a better
  base model often fix what you were going to fine-tune for, in minutes and for free.
- You need a GPU server for training and serving (see [GPU memory](#gpu-memory-rules-of-thumb)), and
  Tatvam connected to it through `GPU_BASE_URL` and `GPU_API_KEY` (see [MODELS.md](MODELS.md)).
- Pick a base model that already handles tools well and whose license allows fine-tuning and your
  intended use. Fine-tuning sharpens behaviour; it rarely teaches a weak model to use tools.

## 1. Collect feedback and corrections

Under every assistant reply and tool call there are thumbs up and down buttons, and a pencil to write
a corrected reply.

- **Thumbs up** marks a reply as a good example.
- **Thumbs down** marks it as bad. A conversation with a thumbs-down and no correction is left out
  of datasets, so it does not teach the mistake.
- **A correction** is the reply you wanted. It replaces the original reply in the training data, and
  the pair (your correction preferred over the original) becomes a DPO preference pair.
- **A note** is for you and other reviewers; it is not trained on.

Corrections are the most valuable signal you can give. A few dozen careful corrections of the
mistakes you see most often do more than hundreds of thumbs-up on replies that were already fine.

## 2. Review and approve conversations

The **Review** tab lists every conversation with its model, message and tool-call counts and its
feedback. Each conversation is `unreviewed`, `approved` or `excluded`; only approved ones go into
datasets by default.

Approve a conversation when:

- the task was completed correctly, with sensible tool calls and no wasted steps;
- the final answer is one you would be happy to see again;
- it contains nothing you would not want in a model's weights (customer data, credentials, private
  documents). Redaction catches common secrets, not everything.

Exclude conversations that went badly and were not corrected, that you abandoned halfway, or that
are mostly small talk. Variety matters: approve conversations across the kinds of work you do, not
fifty versions of the same task.

## 3. Export a dataset

On the **Datasets** tab, choose:

| Option | What it does | Suggested |
| --- | --- | --- |
| Statuses | Which review statuses to include. | Approved only. |
| Kinds | `chat` (your conversations), `distill` (teacher answers), `eval` (evaluation runs). | `chat` and `distill`. Leave `eval` out, or the model trains on the test it will be graded with. |
| Require positive feedback | Keep only conversations with at least one thumbs-up. | On once you have enough rated conversations. |
| Redact PII | Also mask emails, phone numbers and IP addresses. Secrets are always masked. | On, unless the data is purely technical. |
| Eval fraction | Share of examples held out for evaluation during training. | 0.05 to 0.1. |
| System prompt | `agent` (Tatvam's tool-using prompt) or `minimal` (one line). | `agent`, so the model learns in the setting it will be used in. |

The export is written to `DATA_DIR/training/exports/<id>/`:

| File | Contents |
| --- | --- |
| `sft_train.jsonl` | One conversation per line in OpenAI chat format, tool calls and tool results included: `{"messages": [...], "tools": [...]}`. |
| `sft_eval.jsonl` | Held-out examples in the same format. |
| `dpo.jsonl` | Preference pairs from corrections, when there are any: `{"prompt": [...], "chosen": [...], "rejected": [...]}`. `chosen` is your correction, `rejected` the original reply. |
| `manifest.json` | The export settings, counts and file descriptions. |
| `README.md` | A dataset card: what went in, what was skipped and why, and how much was redacted. |

How the data is cleaned:

- **Redaction.** API keys and tokens (GitHub, AWS, Slack, Hugging Face, Google, bearer tokens and
  JWTs), private keys, credentials inside URLs and values stored under names such as `password` or
  `secret` are always replaced with placeholders, including inside tool-call arguments. Workspace paths are rewritten to
  `/workspace`. With PII redaction on, emails, phone numbers and IP addresses are masked too. Read the
  dataset card and skim the files before they leave the machine anyway.
- **Skips.** Conversations without a finished assistant reply, with invalid tool calls, or with an
  uncorrected thumbs-down are left out, and the card says how many and why.
- **Duplicates.** Exact duplicate examples are dropped.
- **Split.** Each example goes to train or eval by a hash of its content, so the split is stable: the
  same conversation lands on the same side in every export, and the eval set never leaks into training.

How much data: a few hundred good conversations noticeably shift style and tool habits; one to five
thousand give robust behaviour. Quality beats quantity every time.

## 4. Measure a baseline

Before training anything, measure the model you use today, so you can tell whether the fine-tune
helped. On the **Evaluations** tab, run the `core` suite against your current model.

- The suite runs each task as a real agent conversation in a scratch copy of a small fixture project
  and checks the result: the right tools were called, the file was edited correctly, the answer
  contains the right value, plan mode was respected. Categories are `tool_use`, `coding`, `research`,
  `instructions` and `safety`.
- An optional **judge** model grades free-form answers against each task's rubric. Use a strong model
  and keep the same judge for every run you compare.
- Look at the **pass rate**, the **tool-call validity** (valid calls divided by all calls; fine-tunes
  often break this first), the average steps and the per-category results.
- Run the baseline two or three times if your model samples with temperature; small suites are noisy.

The Models tab shows each registered model's latest completed eval run, so register your current
model too (kind `base`, status `active`).

## 5. Distill from a larger teacher (optional)

If you have access to a much stronger model, it can write training conversations for a smaller one.
On the **Distillation** tab, pick the teacher (any model on your Ollama or GPU connection) and a source:

- **Prompts:** paste up to 200 tasks, one per entry.
- **History:** re-ask the first message of your recent conversations.

Each prompt becomes a full agent conversation of kind `distill`, hidden from the sidebar. With
**auto-approve** they go straight into the approved pool; without it they wait in the Review tab.
Review at least a sample either way: a teacher's mistakes are copied faithfully.

Check the teacher's license. Some model licenses forbid using outputs to train other models. A kit
built only from distilled data registers the result as kind `distilled`.

## 6. Generate a kit

On the **Fine-tuning** tab, pick the export, the base model (a Hugging Face repo id such as
`Qwen/Qwen3-8B`, or a path on the GPU server), the method, the framework, the hyperparameters and an
output name. Tatvam writes a folder to `DATA_DIR/training/kits/<id>/` with:

| File | Purpose |
| --- | --- |
| `data/` | Copies of the export's dataset files. |
| `requirements.txt` | Python packages, lower-bounded (`torch`, `transformers`, `datasets`, `accelerate`, `peft`, `trl`, plus `bitsandbytes` for QLoRA or `axolotl` for Axolotl). |
| `train.py` or `axolotl.yaml` | The trainer: a commented TRL script (`SFTTrainer` or `DPOTrainer` with a LoRA adapter), or an Axolotl config. Axolotl DPO kits also get `prepare_dpo.py`. |
| `run.sh` | Creates a virtual environment, installs the requirements and trains. |
| `merge_lora.py` | Merges the adapter into the base model, into `merged/<output name>`. |
| `serve_vllm.sh` | Serves the merged model, or the base model plus the adapter, with vLLM. |
| `register.json` | A ready-made body for the model registry. |
| `README.md` | Step-by-step instructions for this kit. |

Every file can also be downloaded from the Fine-tuning tab.

### Choosing a method

| Method | Learns from | Use it when | Notes |
| --- | --- | --- | --- |
| **SFT with LoRA** | `sft_train.jsonl`: imitates approved conversations. | The default. The base model fits on your GPU in 16-bit. | Best quality per training step. |
| **SFT with QLoRA** | The same data. | GPU memory is tight: a 32B model on a 48 GB GPU, or 70B on 80 GB. | The frozen base is stored in 4-bit; a little slower and very slightly less precise. Merging still happens in 16-bit. |
| **DPO with LoRA** | `dpo.jsonl`: prefers your corrections over the original replies. | After SFT, to push the model away from specific recurring mistakes. | Needs preference pairs (at least a hundred or so to matter). Run it on the merged SFT model, with a much lower learning rate. |

TRL or Axolotl: the TRL script is self-contained and easy to read, renders conversations with the
model's own chat template, keeps tool calls in their native format and computes the loss only on the
assistant's turns. Axolotl is a good choice if you already use it; check its rendering with
`axolotl preprocess axolotl.yaml --debug` before a long run.

### Hyperparameters

| Setting | Guidance |
| --- | --- |
| Epochs | 2 to 3 for under a thousand examples, 1 to 2 for more. DPO: 1 to 2. If eval loss rises while training loss falls, use fewer. |
| Learning rate | SFT with LoRA or QLoRA: 1e-4 to 2e-4. DPO: 5e-6 to 5e-5. Halve it if the loss spikes or goes to NaN. |
| LoRA rank | 16 is a good default. 8 for tone and format, 32 to 64 for new domain knowledge or tool skills. |
| LoRA alpha | Usually twice the rank (or equal to it). It scales the adapter's effect. |
| Max sequence length | Long enough for most examples: agent conversations with tool output are long, so 8k to 16k tokens is common. Longer examples are cut. Memory grows with this. |
| Batch size and gradient accumulation | Their product (times the number of GPUs) is the effective batch. Aim for 16 to 32 for SFT and 8 to 16 for DPO. With long sequences keep the batch size at 1 or 2 and raise the accumulation. |

### GPU memory rules of thumb

Rough figures for one GPU at about 4k tokens per example, with gradient checkpointing (which the
kits turn on):

| Base model | SFT with LoRA (16-bit) | SFT with QLoRA (4-bit) | DPO with LoRA |
| --- | --- | --- | --- |
| 7 to 8B | about 25 GB | about 11 GB | about 27 GB |
| 13 to 14B | about 40 GB | about 15 GB | about 44 GB |
| 30 to 32B | about 85 GB (use QLoRA) | about 29 GB | about 95 GB |
| 70 to 72B | far beyond one GPU | about 60 GB | far beyond one GPU |

- Roughly: 16-bit LoRA needs 2.6 GB per billion parameters plus 4 GB; QLoRA 0.8 GB per billion plus
  4 GB. Doubling the sequence length adds a substantial share on top.
- Several GPUs (`NUM_GPUS=2 bash run.sh`) train in data parallel: each GPU holds a full copy, so it
  is faster but does not make a bigger model fit. For that, use QLoRA, or set up FSDP or DeepSpeed
  yourself.
- Merging needs about 2 GB of RAM per billion parameters. Serving a model in 16-bit needs about
  2 GB of GPU memory per billion parameters plus room for the KV cache.

## 7. Fine-tune on the GPU server

Follow the kit's `README.md`. In short:

```bash
rsync -av "<kit folder>/" gpu-host:tatvam-kits/<output name>/
ssh gpu-host
cd tatvam-kits/<output name>
bash run.sh
```

Set `HF_TOKEN` first if the base model is gated. Every setting at the top of `train.py` can be
overridden with an environment variable, for example `EPOCHS=1 bash run.sh`, so you can try a short
run before the real one.

While it runs, watch the loss. Training loss should fall steadily; eval loss should fall and then
level off. Eval loss rising while training loss keeps falling means the model is memorising: stop
earlier, use fewer epochs or a lower learning rate. For DPO, the reward accuracy should climb above
0.5 and the margins should grow.

The dataset contains your conversations and code even after redaction. Keep the kit on machines you
control and delete it from the GPU server when you are done.

## 8. Merge and serve with vLLM

```bash
.venv/bin/python merge_lora.py            # writes merged/<output name>
export VLLM_API_KEY='a-long-random-secret'
bash serve_vllm.sh merged                 # or: bash serve_vllm.sh lora
```

- **Merged** serving bakes the adapter into the weights: simplest, and as fast as the base model.
- **LoRA** serving loads the base model with the adapter on top (`--enable-lora --lora-modules`).
  It skips the merge step, and one vLLM server can host the base model and several adapters at once.

Either way the model is served under the output name. The script reads the API key from
`VLLM_API_KEY` (never from a file or the command line) and listens on 127.0.0.1. Reach it through an
SSH tunnel or a TLS proxy on a private network; never expose the port to the internet. Check the
tool-call parser in `serve_vllm.sh` matches the model family (`hermes` for Qwen, `llama3_json` for
Llama, `mistral` for Mistral), or tool calls will come back as plain text.

Then point Tatvam at it (`GPU_BASE_URL`, `GPU_API_KEY` in `.env.local`) and restart. The new model
appears under the GPU server in the model picker.

## 9. Register the model

On the **Models** tab, register the model with the values from the kit's `register.json`: provider
`gpu`, the output name as the model id, kind `finetune` (or `distilled`), status `candidate`, the
dataset export it was trained on and, if registered, its parent base model. The registry keeps the
lineage of every model and shows its latest evaluation.

## 10. Evaluate the candidate against the baseline

Run the same suite with the same judge against the candidate. Compare it with the baseline:

- The pass rate should go up, or stay level while your own feedback improves.
- Tool-call validity should not drop. If it does, check the chat template and the vLLM tool-call
  parser before blaming the training.
- No category should get clearly worse, and **safety** must not regress at all.
- A difference of one or two tasks on a small suite is noise; rerun before deciding.

If the candidate is worse, the usual causes are too many epochs or too high a learning rate
(it has forgotten general skills), too little or too repetitive data, or a mismatch between how the
data was rendered and how the model is served.

## 11. Canary through the router

Trying a model on real work is the final test. On the **Models** tab (Router), or with
`PUT /api/router`, keep your current model as `main` and send a share of new conversations to the
candidate:

```json
{
  "enabled": true,
  "main": { "provider": "gpu", "model": "qwen3-8b" },
  "subagent": null,
  "judge": null,
  "fallback": { "provider": "ollama", "model": "qwen3:8b" },
  "canary": { "model": { "provider": "gpu", "model": "tatvam-coder-v1" }, "percent": 10 }
}
```

- The router applies to chats where the model picker is set to **Auto (router)**. A conversation
  stays on the model it started with, so a canary conversation never switches models halfway.
- `fallback` answers when the primary model is unreachable or returns a server error.
- Start at 5 to 10 percent for a few days. On the Review tab, the model column shows which
  conversations ran on the candidate; compare their thumbs up and down with the main model's.

## 12. Promote or retire

- **Promote:** set the candidate as the router's `main` model, remove the canary, and mark it
  `active` on the Models tab. Mark the model it replaces `retired` (or keep it as the `fallback`).
- **Retire:** remove the canary and mark the candidate `retired`. Keep its kit and notes: the next
  attempt starts from there.
- **Roll back** at any time by setting `main` back to the previous model. Nothing else changes.

Then start the next round: keep rating and correcting, export again, and train from the same base
model with the bigger dataset (not on top of the previous fine-tune, unless you mean to).

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Out of GPU memory | Lower the batch size and raise gradient accumulation by the same factor, lower the max sequence length, or switch to QLoRA. |
| Loss is NaN or spikes | Learning rate too high: halve it. On older GPUs without bfloat16, try a lower rate. |
| Loss falls to almost zero | Too many epochs or too little data: the model is memorising. |
| Tool calls come back as text after fine-tuning | vLLM tool-call parser does not match the model family, or the base model's chat template has no tool support. |
| The model never stops talking | The end-of-turn token differs from the EOS token. Set `END_OF_TURN` (for example `<\|im_end\|>`) in the TRL kit and retrain. |
| DPO kit refused | The export has no preference pairs. Write corrections on replies, export again. |
| A library update broke a script | Install the versions from a run that worked (`pip freeze`) instead of the lower bounds. |

## API reference

All endpoints answer same-origin requests on the Tatvam server (see the safety model in the README).

| Endpoint | Purpose |
| --- | --- |
| `PUT /api/conversations/:id/feedback` | Rate, correct or annotate a reply or tool call. |
| `PUT /api/conversations/:id/training` | Set a conversation's review status. |
| `GET /api/training/conversations?status=&kind=` | The review queue. |
| `GET`, `POST /api/training/exports` | List or create dataset exports. |
| `GET`, `DELETE /api/training/exports/:id`, `GET /api/training/exports/:id/files/:name` | Inspect, delete or download an export. |
| `GET /api/evals/suites`, `GET`, `POST /api/evals/runs`, `GET /api/evals/runs/:id`, `POST /api/evals/runs/:id/cancel` | Evaluation suites and runs. |
| `GET`, `POST /api/training/distill`, `GET /api/training/distill/:id`, `POST /api/training/distill/:id/cancel` | Distillation jobs. |
| `GET`, `POST /api/training/kits` | List or generate fine-tuning kits (`404` for an unknown export, `400` for DPO without pairs). |
| `GET /api/training/kits/:id/files/:name` | Download one file of a kit; nested names such as `data/sft_train.jsonl` are URL-encoded. |
| `GET`, `POST /api/models/registry` | List or register models (`409` for a duplicate provider and model id). |
| `PATCH`, `DELETE /api/models/registry/:id` | Update or remove a registered model. |
| `GET`, `PUT /api/router` | The model router: main, sub-agent, judge, fallback and canary models. |
