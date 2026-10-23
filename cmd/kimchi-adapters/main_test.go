package main

import "testing"

func TestCSVFormulaEscaping(t *testing.T) {
	for _, v := range []string{"=HYPERLINK(\"bad\")", "+1", "-1", "@x", "\tvalue", "\rvalue"} {
		if csvText(v) != "'"+v {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"", "123", "normal"} {
		if csvText(v) != v {
			t.Fatal(v)
		}
	}
}
