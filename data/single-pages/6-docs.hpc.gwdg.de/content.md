# Available Models

Chat AI provides a large assortment of state-of-the-art open-weight Large Language Models (LLMs) which are hosted on our platform with the highest standards of data protection. The data sent to these models, including the prompts and message contents, are never stored at any location on our systems. Additionally, Chat AI offers models hosted externally such as OpenAI’s GPT-5, GPT-4o, and o3.

Available models are regularly upgraded as newer, more capable ones are released. We select models to include in our services based on user demand, cost, and performance across various benchmarks, such as HumanEval, MATH, HellaSwag, MMLU, etc. Certain models are more capable at specific tasks and with specific settings, which are described below to the best of our knowledge.

### List of open-weight models, hosted by GWDG

| Organization | Model | Open | Knowledge cutoff | Context window in tokens | Advantages | Limitations | Recommended settings |

| --- | --- | --- | --- | --- | --- | --- | --- |

| 🇺🇸 Meta | Llama 3.1 8B Instruct | yes | Dec 2023 | 128k | Fast overall performance | - | default |

| 🇺🇸 OpenAI | GPT OSS 120B | yes | Jun 2024 | 128k | Great overall performance, fast | - | default |

| 🇺🇸 Google | Gemma 3 27B Instruct | yes | Mar 2024 | 128k | Vision, great overall performance | - | default |

| 🇨🇳 OpenGVLab | InternVL2.5 8B MPO | yes | Sep 2021 | 32k | Vision, lightweight and fast | - | default |

| 🇨🇳 Alibaba Cloud | Qwen 3 235B A22B Thinking 2507 | yes | Apr 2025 | 222k | Great overall performance,reasoning | - | temp=0.6, top_p=0.95 |

| 🇨🇳 Alibaba Cloud | Qwen 3 32B | yes | Sep 2024 | 32k | Good overall performance,multilingual, global affairs, logic | - | default |

| 🇨🇳 Alibaba Cloud | Qwen QwQ 32B | yes | Sep 2024 | 131k | Good overall performance,reasoning and problem-solving | Political bias | defaulttemp=0.6, top_p=0.95 |

| 🇨🇳 DeepSeek | DeepSeek R1 0528 | yes | Dec 2023 | 32k | Great overall performance,reasoning and problem-solving | Censorship, political bias | default |

| 🇨🇳 DeepSeek | DeepSeek R1 Distill Llama 70B | yes | Dec 2023 | 32k | Good overall performance,faster than R1 | Censorship, political bias | defaulttemp=0.7, top_p=0.8 |

| 🇺🇸 Meta | Llama 3.3 70B Instruct | yes | Dec 2023 | 128k | Good overall performance,reasoning and creative writing | - | defaulttemp=0.7, top_p=0.8 |

| 🇺🇸 Google | MedGemma 27B Instruct | yes | Mar 2024 | 128k | Vision, medical knowledge | - | default |

| 🇩🇪 VAGOsolutions x Meta | Llama 3.1 SauerkrautLM 70B Instruct | yes | Dec 2023 | 128k | German language skills | - | default |

| 🇫🇷 Mistral | Mistral Large Instruct | yes | Jul 2024 | 128k | Good overall performance,coding and multilingual reasoning | - | default |

| 🇫🇷 Mistral | Codestral 22B | yes | Late 2021 | 32k | Coding tasks | - | temp=0.2, top_p=0.1temp=0.6, top_p=0.7 |

| 🇺🇸 intfloat x Mistral | E5 Mistral 7B Instruct | yes | - | 4096 | Embeddings | API Only | - |

| 🇨🇳 Alibaba Cloud | Qwen 2.5 VL 72B Instruct | yes | Sep 2024 | 90k | Vision, multilingual | - | default |

| 🇨🇳 Alibaba Cloud | Qwen 2.5 Coder 32B Instruct | yes | Sep 2024 | 128k | Coding tasks | - | defaulttemp=0.2, top_p=0.1 |

| 🇩🇪 OpenGPT-X | Teuken 7B Instruct Research | yes | Sep 2024 | 128k | European languages | - | default |

### List of external models, hosted by external providers

| Organization | Model | Open | Knowledge cutoff | Context window in tokens | Advantages | Limitations | Recommended settings |

| --- | --- | --- | --- | --- | --- | --- | --- |

| 🇺🇸 OpenAI | GPT-5 Chat | no | Jun 2024 | 400k | Great overall performance, vision | - | default |

| 🇺🇸 OpenAI | GPT-5 | no | Jun 2024 | 400k | Best overall performance, reasoning, vision | - | default |

| 🇺🇸 OpenAI | GPT-5 Mini | no | Jun 2024 | 400k | Fast overall performance, vision | - | default |

| 🇺🇸 OpenAI | GPT-5 Nano | no | Jun 2024 | 400k | Fastest overall performance, vision | - | default |

| 🇺🇸 OpenAI | o3 | no | Oct 2023 | 200k | Good overall performance, reasoning, vision | outdated | default |

| 🇺🇸 OpenAI | o3-mini | no | Oct 2023 | 200k | Fast overall performance, reasoning | outdated | default |

| 🇺🇸 OpenAI | GPT-4o | no | Oct 2023 | 128k | Good overall performance, vision | outdated | default |

| 🇺🇸 OpenAI | GPT-4o Mini | no | Oct 2023 | 128k | Fast overall performance, vision | outdated | default |

| 🇺🇸 OpenAI | GPT-4.1 | no | June 2024 | 1M | Good overall performance | outdated | default |

| 🇺🇸 OpenAI | GPT-4.1 Mini | no | June 2024 | 1M | Fast overall performance | outdated | default |

## Open-weight models, hosted by GWDG

The models listed in this section are hosted on our platform with the highest standards of data protection. The data sent to these models, including the prompts and message contents, are never stored at any location on our systems.

#### Meta Llama 3.1 8B Instruct

The standard model we recommend. It is the most lightweight with the fastest performance and good results across all benchmarks. It is sufficient for general conversations and assistance.

#### OpenAI GPT OSS 120B

In August 2025 OpenAI released the gpt-oss model series, consisting of two open-weight LLMs that are optimized for faster inference with state-of-the-art performance across many domains, including reasoning and tool use. According to OpenAI, the gpt-oss-120b model achieves near-parity with OpenAI o4-mini on core reasoning benchmarks.

#### Meta Llama 3.3 70B Instruct

Achieves good overall performance, on par with GPT-4, but with a much larger context window and more recent knowledge cutoff. Best in English comprehension and further linguistic reasoning, such as translations, understanding dialects, slang, colloquialism and creative writing.

### Google Gemma 3 27B Instruct

Gemma is Google’s family of light, open-weights models developed with the same research used in the development of its commercial Gemini model series. Gemma 3 27B Instruct is quite fast and thanks to its support for vision (image input), it is a great choice for all sorts of conversations.

### Google MedGemma 27B Instruct

MedGemma 27B Instruct is a variant of Gemma 3 suitable for medical text and image comprehension. It has been trained on a variety of medical image data, including chest X-rays, dermatology images, ophthalmology images, and histopathology slides, as well as medical text, such as medical question-answer pairs, and FHIR-based electronic health record data. MedGemma variants have been evaluated on a range of clinically relevant benchmarks to illustrate their baseline performance.

#### Qwen 3 235B A22B Thinking 2507

Expanding on Qwen 3 235B A22B, one of the best-performing models of the Qwen 3 series, Qwen 3 235B A22B Thinking 2507 has a significantly improved performance on reasoning tasks, including logical reasoning, mathematics, science, coding, and academic benchmarks. It is an MoE model with 235B total parameters and 22B activated parameters, and achieves state-of-the-art results among open-weights thinking models.

#### Qwen 3 32B

Qwen 3 32B is a large dense model developed by Alibaba Cloud released in April 2025. It supports reasoning and outperforms or is at least on par with other state-of-the-art reasoning models such as OpenAI o1 and DeepSeek R1.

#### Qwen QwQ 32B

Developed by Alibaba Cloud, QwQ is the reasoning model of the Qwen series of LLMs. Compared to non-reasoning Qwen models, it achieves significnatly higher performance in tasks that require problem-solving. QwQ 32B is lighter and faster than DeepSeek R1 and OpenAI’s o1, but achieves comparable performance.

#### Qwen 2.5 VL 72B Instruct

A powerful Vision Language Model (VLM) with competitive performance in both langauge and image comprehension tasks.

#### Qwen 2.5 Coder 32B Instruct

Qwen 2.5 Coder 32B Instruct is a code-specific LLM based on Qwen 2.5. It has one of the highest scores on code-related tasks, on par with OpenAI’s GPT-4o, and is recommended for code generation, code reasoning and code fixing.

#### DeepSeek R1 0528

Developed by the Chinese company DeepSeek (深度求索), DeepSeek R1 was the first highly-capable open-weights reasoning model to be released. In the latest update, DeepSeek R1 0528, its depth of reasoning and inference capabilities has increased. Although very large and quite slow, it achieves one of the best overall performances among open models.

DeepSeek models, including R1, have been reported to produce politically biased responses, and censor certain topics that are sensitive for the Chinese government.

#### DeepSeek R1 Distill Llama 70B

Developed by the Chinese company DeepSeek (深度求索), DeepSeek R1 Distill Llama 70B is a dense model distilled from DeepSeek-R1 but based on LLama 3.3 70B, in order to fit the capabilities and performance of R1 into a 70B parameter-size model.

#### Llama 3.1 SauerkrautLM 70B Instruct

SauerkrautLM is trained by VAGOsolutions on Llama 3.1 70B specifically for prompts in German.

#### Mistral Large Instruct

Developed by Mistral AI, Mistral Large Instruct 2407 is a dense language model with 123B parameters. It achieves great benchmarking scores in general performance, code and reasoning, and instruction following. It is also multi-lingual and supports many European and Asian languages.

#### Codestral 22B

Codestral 22B was developed by Mistral AI specifically for the goal of code completion. It was trained on more than 80 different programming languages, including Python, SQL, bash, C++, Java, and PHP. It uses a context window of 32k for evaluation of large code generating, and can fit on one GPU of our cluster.

#### InternVL2.5 8B MPO

A lightweight, fast and powerful Vision Language Model (VLM), developed by OpenGVLab. It builds upon InternVL2.5 8B and Mixed Preference Optimization (MPO).

#### OpenGPT-X Teuken 7B Instruct Research

OpenGPT-X is a research project funded by the German Federal Ministry of Economics and Climate Protection (BMWK) and led by Fraunhofer, Forschungszentrum Jülich, TU Dresden, and DFKI. Teuken 7B Instruct Research v0.4 is an instruction-tuned 7B parameter multilingual LLM pre-trained with 4T tokens, focusing on covering all 24 EU languages and reflecting European values.

## External models, hosted by external providers

These OpenAI models are hosted on Microsoft Azure, and Chat AI only relays the contents of your messages to their servers. Microsoft adheres to GDPR and is contractually bound not to use this data for training or marketing purposes, but they may store messages for up to 30 days. We therefore recommend the open-weight models, hosted by us, to ensure the highest security and data privacy.

### OpenAI GPT-5 Series

Released in August 2025, OpenAI’s GPT-5 series models achieve state-of-the-art performance across various benchmarks, with a focus on coding and agentic tasks. The series consists of the following four models along with their intended use cases:

- OpenAI GPT-5 Chat: Non-reasoning model. Designed for advanced, natural, multimodal, and context-aware conversations.
- OpenAI GPT-5: Reasoning model. Designed for logic-heavy and multi-step tasks.
- OpenAI GPT-5 Mini: A lightweight variant of GPT-5 for cost-sensitive applications.
- OpenAI GPT-5 Nano: A highly optimized variant of GPT-5. Ideal for applications requiring low latency.

#### OpenAI o3

Released in April 2025, OpenAI’s o3-class models were developed to perform complex reasoning tasks across the domains of coding, math, science, visual perception, and more. These models have an iterative thought process, and therefore take their time to process internally before responding to the user. The thought process for o3 models are not shown to the user.

#### OpenAI GPT-4o

GPT 4o (“o” for “omni”) is a general-purpose model developed by OpenAI. This model improves on the relatively older GPT 4, and supports vision (image input) too.

#### OpenAI GPT-4.1

OpenAI’s GPT-4.1-class models improve on the older GPT-4 series. These models also outperform GPT-4o and GPT-4o Mini, especially in coding and instruction following. They have a large context window size of 1M tokens, with improved long-context comprehension, and an updated knowledge cutoff of June 2024.

#### OpenAI o3 Mini

This was developed as a more cost-effective and faster alternative to o3.

#### OpenAI GPT-4o Mini

This was developed as a more cost-effective and faster alternative to GPT 4o.

#### OpenAI GPT-4.1 Mini

This was developed as a more cost-effective and faster alternative to GPT-4.1.

#### OpenAI o1 and o1 Mini

OpenAI’s o1-class models were developed to perform complex reasoning tasks. These models have now been superceded by the o3-series, and are therefore no longer recommended.

#### OpenAI GPT-3.5 and GPT-4

These models are outdated and not available anymore.
