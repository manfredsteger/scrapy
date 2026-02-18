# Chat AI

![Chat AI Logo](https://docs.hpc.gwdg.de/img/services/chatai-logo.png)

Chat AI is a stand-alone LLM (large language model) web service that we provide, which hosts multiple LLMs on a scalable backend. It runs on our cloud virtual machine with secure access to run the LLMs on our HPC systems. It is our secure solution to commercial LLM services, where none of your data gets used by us or stored on our systems.

The service can be reached via a it’s web interface.
To use the models via the API, refer to API Request, and to use the models via Visual Studio Code, refer to CoCo AI.

If all you need is a quick change of your persona, this is the page you are looking for.

You need an Academic Cloud account to access the AI Services.
Use the federated login or create a new account. Details are on this page.

## Current Models

Chat AI currently hosts a large assortment of high-quality, open-source models. All models except ChatGPT are self-hosted with the guarantee of the highest standards of data protection. These models run completely on our hardware and don’t store any user data.

For more detailed information about all our models, please refer to available models.

## Web interface and usage

If you have an AcademicCloud account, the web interface can also easily be reached here. All models of ChatAI are free to use, for free, for all users, with the exception of the ChatGPT models, which are only freely available to public universities and research institutes in Lower Saxony and the Max Planck Society.

Choose a model suitable to your needs from the available models.
After learning the basic usage, learn about ChatAI’s advanced features here

From the web interface, there are built-in actions that can make your prompts easier or better. These include:

- Attach (+ button): Add files that the model use as context for your prompts.
- Listen (microphone button): Speak to the model instead of typing.
- Import/Export (upload/download button): If you have downloaded conversations from a previous ChatAI session or another service, you can import that session and continue it.
- Footer (bottom arrow): Change the view to include the footer, which includes “Terms of use”, “FAQ”, etc. and the option to switch between English and German.
- Light/Dark mode (sun/moon button): Toggle between light and dark mode.
- Options: Further configuration options for tailoring your prompts and model more closely. These include :System prompt, which can be considered the role that the model should assume for your prompts. The job interview prompt above is an example.Completion options such as temperature and top_p sampling.Share button, which generates a shareable URL for Chat AI that loads your current model, system prompt, and other settings. Note that this does not include your conversation.Clear button, which deletes the entire data stored in your browser, removing your conversations and settings.Memory Settings, the system supports three memory modes to control conversational context:None: Disables memory—each conversation is treated independently.Recall: Adds previous messages to the system prompt for contextual continuity.Learn: Extends Recall by updating memory with relevant parts of the current conversation, enabling a more natural dialogue flow.

> Note: Memory is stored locally in the browser and does not affect external (OpenAI) models.

We suggest to set a system prompt before starting your session in order to define the role the model should play. A more detailed system prompt is usually better. Examples include:

- “I will ask questions about data science, to which I want detailed answers with example code if applicable and citations to at least 3 research papers discussing the main subject in each question.”
- “I want the following text to be summarized with 40% compression. Provide an English and a German translation.”
- “You are a difficult job interviewer at the Deutsch Bahn company and I am applying for a job as a conductor”.

### Completion options

Two important concepts to understand among completion options are temperature and top_p sampling.

- temperature is a slider from 0 to 2 adjusting the creativity, with closer to 0 being more predictable and closer to 2 being more creative. It does this by expanding or flattening the probabilities of the next token (response building block).
- top_p is a slider from 0 to 1 which adjusts the total population of probabilities considered for the next token. A top_p of 0.1 would mean that only the top 10% of cumulative probabilities are considered. Varying top_p has a similar effect on predictability and creativity as temperature, with larger values considered to increase creativity.

Predictable results, for tasks such as coding, require low values for both parameters, and creative results, for tasks such as brainstorming, require high values. See the table in the available models section for value suggestions.

## Features

More comprehensive documentation for all features is found here.

- Arcana / RAG
- Tools
- Memory
- Personas
- Model Context Protocol (MCP)

### Chat AI Tools

The settings window shows you an option to activate tools.
Once activated, these tools are available:

- Web Search
- Image generation
- Image editing
- text to speech (tts)

Also, if you want to use Toolbox, meaning the image, video, and audio features of the models, you need to activate the tools in the settings.

These tools only work using the models hosted by GWDG and KISSKI. The external models from OpenAI do not work with the tools.

### Web Search

This tool works by creating a search query that can be used with search engines.
The entire chat history is used and processed to create a short search query that generates a processable response.
Once the response is retrieved from the search engine it is used together with the model to write a reply to the prompt.

Most importantly, this allows the response to contain recent information instead of the outdated information present in the model that was selected.

For more information, check out the Tools Documentation.

## Acknowledgements

We thank Priyeshkumar Chikhaliya for the design and implementation of the web interface.

We thank all colleagues and partners involved in this project.

## Citation

If you use Chat AI in your research, services or publications, please cite us as follows:

```bibtex
@misc{doosthosseiniSAIASeamlessSlurmNative2025,
  title = {{{SAIA}}: {{A Seamless Slurm-Native Solution}} for {{HPC-Based Services}}},
  shorttitle = {{{SAIA}}},
  author = {Doosthosseini, Ali and Decker, Jonathan and Nolte, Hendrik and Kunkel, Julian},
  year = {2025},
  month = jul,
  publisher = {Research Square},
  issn = {2693-5015},
  doi = {10.21203/rs.3.rs-6648693/v1},
  url = {https://www.researchsquare.com/article/rs-6648693/v1},
  urldate = {2025-07-29},
  archiveprefix = {Research Square}
}
```

## Further services

If you have questions, please browse the FAQ first.
For more detail on how the service works, you can read our research paper here.
If you have more specific questions, feel free to contact us at kisski-support@gwdg.de.
