# Reading workflow results

A workflow is a sequence of tasks. A run is one execution of that workflow. A saved result file lets you inspect what happened without running the work again.

## Start with the result

1. Open the run and check its status. **Passed** means its declared checks passed. **Failed** or **Interrupted** means the complete result is not ready.
2. Select a step in the diagram, or click **Inspect** on its card.
3. **Input** shows the data received; **Output** shows the saved result. Click a table row to read its fields in **Record** view. **JSON** is the original structured value for technical review.
4. To understand an AI answer, open **Calls** and select the request. Its input, prompt and answer appear together. A response containing only a JSON code block can also be read as a record; **Original** preserves the exact text. **View failed requests** narrows the list to recorded failures.
5. **Files** contains the saved documents and datasets. **Checks** explains how the step was verified.

The inspector can show only evidence the workflow saved. An empty history does not mean that no work took place. A check passing does not guarantee every conclusion is correct: the analyst still evaluates the content.

## Open a file someone sent you

After Flora has been installed, open a terminal in the folder containing the file and run:

```text
flora open "result.flora-run"
```

Your browser opens the result. Keep that terminal open while reading. Viewing a completed result does not require an AI subscription and does not call a model.

## Run the workflow again

The workflow file ends in **.flora**; the saved result ends in **.flora-run**. A new run needs the workflow and the executor specified by its author, for example a logged-in Claude CLI. Use the workflow's supplied launch instructions and a new output folder.

This viewer currently reads results; it does not yet provide a form or button for starting a new workflow. The setup and launch commands should be supplied by the workflow author. You do not need to edit code or prompts just to read a result.

On an error, open the failed request and share its identifier and message with the workflow author. Partial results are useful for inspection but should not be presented as a completed study.
