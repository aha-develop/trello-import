import React from "https://cdn.skypack.dev/react";
import marked from "https://cdn.skypack.dev/marked";

const importer = aha.getImporter("aha-develop.trello-import.cards");

async function trelloGet(path) {
  const auth = await aha.auth("trello", { useCachedRetry: true });

  const init = {
    method: "GET",
    headers: {
      Authorization: `OAuth oauth_consumer_key="${auth.key}", oauth_token="${auth.token}"`,
    },
  };

  const request = new Request(`https://api.trello.com/1${path}`, init);

  return fetch(request).then((response) => {
    if (!response.ok) {
      if (response.status === 401) {
        throw new aha.AuthError(
          `Trello authentication error: ${response.status}`,
          "trello"
        );
      } else {
        throw new Error(`Trello API error: ${response.status}`);
      }
    }

    return response.json();
  });
}

importer.on(
  { action: "listCandidates" },
  async ({ filters, nextPage }, { identifier, settings }) => {
    if (!filters.board) return { records: [] };

    const cards = await trelloGet(`/boards/${filters.board}/cards`);
    const lists = await trelloGet(`/boards/${filters.board}/lists`);

    const listsById = Object.fromEntries(lists.map((l) => [l.id, l]));

    return {
      records: cards.map((card) => ({
        uniqueId: card.id,
        list: listsById[card.idList]?.name,
        name: card.name,
        url: card.url,
        description: card.desc,
        labels: card.labels,
      })),
    };
  }
);

importer.on({ action: "listFilters" }, async ({}, { identifier, settings }) => {
  return {
    board: {
      title: "Board",
      required: true,
      type: "select",
    },
  };
});

importer.on(
  { action: "filterValues" },
  async ({ filterName, filters }, { identifier, settings }) => {
    let values = [];
    switch (filterName) {
      case "board":
        const boards = await trelloGet("/members/me/boards?fields=name,id");
        values = boards.map((b) => ({ text: b.name, value: b.id }));
        break;
      default:
        break;
    }
    return values;
  }
);

importer.on(
  { action: "renderRecord" },
  ({ record, onUnmounted }, { identifier, settings }) => {
    return (
      <div>
        <span className="text-muted">{record.list}</span>
        <br />
        <a href={aha.sanitizeUrl(record.url)} target="_blank" rel="noopener">
          {record.name}
        </a>
      </div>
    );
  }
);

importer.on(
  { action: "importRecord" },
  async ({ importRecord, ahaRecord }, { identifier, settings }) => {
    let success = false;

    // Import Markdown description as HTML, with a link back to the original card
    ahaRecord.description =
      marked(importRecord.description) +
      `<p><a href='${aha.sanitizeUrl(
        importRecord.url
      )}'>View on Trello</a></p>`;

    // Import tags as labels
    ahaRecord.tagList = importRecord.labels
      .map((label) => (label.name === "" ? label.color : label.name))
      .join(",");

    success = await ahaRecord.save();
    if (!success) return false;

    // Import checklists as requirements
    const checklists = await trelloGet(
      `/cards/${importRecord.uniqueId}/checklists`
    );

    for (const list of checklists) {
      const requirement = new aha.models.Requirement({
        name: list.name,
        feature: ahaRecord,
      });

      success = await requirement.save({
        args: {
          skipRequiredFieldsValidation: true,
        },
      });
      if (!success) return false;

      // Import checklist items as todos on the requirement
      const tasks = list.checkItems.map((item, i) => {
        const status =
          item.state === "complete"
            ? aha.enums.TaskStatusEnum.COMPLETE
            : aha.enums.TaskStatusEnum.PENDING;

        return new aha.models.Task({
          name: item.name,
          body: "",
          position: i + 1,
          record: requirement,
          status: status,
          dueDate: item.due,
        });
      });

      for (const task of tasks) {
        success = await task.save();
        if (!success) return false;
      }
    }

    return true;
  }
);
