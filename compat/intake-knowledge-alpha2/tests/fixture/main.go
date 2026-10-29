// Synthetic-only integration fixture. Init refuses any existing reference DB.
package main

import (
	"aistore/library/domain"
	"aistore/library/store"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 || !filepath.IsAbs(os.Args[1]) {
		return fmt.Errorf("one absolute NEW fixture directory is required")
	}
	base := os.Args[1]
	if err := os.Mkdir(base, 0700); err != nil {
		return err
	}
	ctx := context.Background()
	root := filepath.Join(base, "store")
	if err := store.Init(ctx, root); err != nil {
		return err
	}
	s, err := store.Open(ctx, root, true)
	if err != nil {
		return err
	}
	defer s.Close()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(root, "data/store.sqlite3"))
	if err != nil {
		return err
	}
	defer db.Close()
	put := func(v any) (domain.ObjectHash, error) {
		b, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		return s.PutObject(ctx, bytes.NewReader(b))
	}
	var ids []domain.ReferenceID
	for i, articleText := range []string{
		"Synthetic public knowledge: counterfoil retrieval separates external claims from adopted procedures. Compare evidence before changing a workflow. 原資料と手順を分ける。",
		"PRIVATE_UNSHARED_ARTICLE should never influence a shared query.",
	} {
		raw := fmt.Sprintf("https://example.test/knowledge-%d", i+1)
		id, canonical, err := domain.Identity(raw)
		if err != nil {
			return err
		}
		ids = append(ids, id)
		original, err := s.PutObject(ctx, strings.NewReader("PRIVATE_ORIGINAL"))
		if err != nil {
			return err
		}
		content, err := s.PutObject(ctx, strings.NewReader("PRIVATE_RAW_BODY_ONLY"))
		if err != nil {
			return err
		}
		_, err = db.ExecContext(ctx, `INSERT INTO reference_records(reference_id,url,kind,medium,recorded_category,original_hash,content_hash,content_scope,has_text,source_json,metadata_json) VALUES(?,?,'web','text','programming',?,?,'verbatim-excerpt',1,'{"private":"PRIVATE_SLACK"}','{"credential":"PRIVATE_CREDENTIAL"}')`, id, canonical, original, content)
		if err != nil {
			return err
		}
		decision := fmt.Sprintf("synthetic-decision-%d", i)
		_, err = db.ExecContext(ctx, `INSERT INTO decisions(decision_id,reference_id,status,category,summary,evidence_hash,applied,origin) VALUES(?,?,'classified','programming','Synthetic shared summary',?,1,'synthetic')`, decision, id, original)
		if err != nil {
			return err
		}
		if _, err = db.ExecContext(ctx, `UPDATE reference_records SET registered=1,current_decision_id=? WHERE reference_id=?`, decision, id); err != nil {
			return err
		}
		source, err := s.PutObject(ctx, strings.NewReader("Synthetic public evidence anchor"))
		if err != nil {
			return err
		}
		input, err := put(domain.ReaderInput{Items: []domain.ReadingItem{{Identity: id, Materials: []domain.Material{{URL: raw, Hash: source, Text: "Synthetic public evidence anchor", Scope: "full"}}}}})
		if err != nil {
			return err
		}
		article := domain.Article{Identity: id, Status: domain.ArticleReady, Text: articleText, Summary: "Synthetic summary", Sources: []domain.ArticleSource{{URL: raw, Hash: source}}, Anchors: []domain.Anchor{{Hash: source, Quote: "public evidence"}}}
		result, err := put(domain.ReaderResult{Items: []domain.Article{article}})
		if err != nil {
			return err
		}
		runID := domain.RunID(fmt.Sprintf("run:knowledge-fixture-%d", i))
		if err = s.CreateRun(ctx, domain.Run{ID: runID, CampaignID: string(runID), ReviewLimit: 1, Status: "open", PipelineVersion: 1, InputHash: input, ConfigHash: input}); err != nil {
			return err
		}
		task := domain.Task{ID: domain.TaskID(fmt.Sprintf("reader:knowledge-fixture-%d", i)), RunID: runID, Kind: "reader", InputHash: input, Route: domain.Route{Provider: "synthetic", Model: "fixed"}, AuthorityHash: input, Authorized: true, MaxAttempts: 1, IdempotencyKey: "reader"}
		if err = s.CreateTask(ctx, task); err != nil {
			return err
		}
		claim, err := s.ClaimTask(ctx, task.ID, input)
		if err != nil {
			return err
		}
		if err = s.MarkInFlight(ctx, claim); err != nil {
			return err
		}
		if err = s.AcceptTask(ctx, task.ID, claim.Attempt, domain.TaskResult{InputHash: input, ResultHash: result, ActualRoute: task.Route}); err != nil {
			return err
		}
		hashes, err := s.SaveReaderArticles(ctx, task.ID)
		if err != nil || len(hashes) != 1 {
			return fmt.Errorf("save synthetic article: %v", err)
		}
		approval, err := put(domain.ArticleApproval{ArticleHash: hashes[0], Approved: true, Reason: "Synthetic content verified", Reviewer: "synthetic"})
		if err != nil {
			return err
		}
		if err = s.ApproveArticle(ctx, hashes[0], approval); err != nil {
			return err
		}
	}
	db.Close()
	s.Close()
	s, err = store.Open(ctx, root, false)
	if err != nil {
		return err
	}
	defer s.Close()
	home := filepath.Join(base, "state")
	draft, err := s.PrepareKnowledgeScope(ctx, home, filepath.Join(base, "sharing", "draft.json"), ids[:1], true)
	if err != nil {
		return err
	}
	approved, err := s.ApproveKnowledgeScope(ctx, draft.Path, draft.Hash, filepath.Join(base, "sharing", "scope.json"), "synthetic-only-human-approval")
	if err != nil {
		return err
	}
	scope, _, err := store.ReadKnowledgeScope(approved.Path)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"synthetic": true, "storeRoot": root, "stateHome": home, "scopeFile": approved.Path, "draftFile": draft.Path, "identity": ids[0], "unsharedIdentity": ids[1], "materialVersion": scope.Entries[0].MaterialVersion})
}
