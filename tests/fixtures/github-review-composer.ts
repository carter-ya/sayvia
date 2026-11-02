// Structural snapshot of the public decimal PR #15 composer, inspected 2026-11-02.
// No account data or draft content is captured. GitHub renders the linked
// markdown-toolbar hidden and uses an unlinked visible ActionBar for formatting.
export function reviewComposer(id: string, text = '你好 `sql.Scanner`') {
  return `<fieldset id="${id}-composer" aria-disabled="false">
    <legend>Add diff comment</legend><div class="container__l8D3Du">
      <span id="${id}-description">Markdown input: edit mode selected.</span>
      <markdown-toolbar for="${id}" role="toolbar" style="display:none"><md-bold></md-bold></markdown-toolbar>
      <div style="display:contents"><div class="ConversationCommentBox__0Itdcg writeWrapper__4K2MB1">
        <div class="header__3BFPRT"><nav aria-label="View mode"><button type="button" role="tab">Write</button><button type="button" role="tab">Preview</button></nav>
          <div data-component="ActionBar"><div role="toolbar" aria-label="Formatting tools"><div class="prc-ActionBar-OverflowContainer-AkYZs"><button type="button">B</button><button type="button">I</button><button type="button">Link</button><button type="button">Quote</button><button type="button">List</button></div><button type="button" aria-label="More formatting tools">…</button></div></div>
        </div><div class="inputWrapper__Y2hEnV"><div><div class="container__YpJHmd"><span data-component="TextInput">
          <textarea id="${id}" data-component="Textarea" data-resize="both" rows="5" cols="30" aria-required="false" aria-invalid="false" placeholder="Leave a comment" aria-label="Markdown value" aria-describedby="${id}-description">${text}</textarea>
        </span></div></div></div>
      </div></div>
    </div><button type="button">Cancel</button><button type="button" onclick="this.parentElement.querySelector('output').textContent='submitted'">Start a review</button><output>not submitted</output>
  </fieldset>`;
}
