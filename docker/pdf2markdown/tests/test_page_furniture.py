from pdf2markdown.page_furniture import document_furniture, page_furniture


def test_page_furniture_preserves_alignment_and_shared_rows():
    page = {
        "index": 0,
        "dimensions": {"width": 800, "height": 1000},
        "markdown": "104\n\nCHAPTER 4 IMPLEMENTING A GPT MODEL\n\nBody text.\n\nPublisher footer",
        "blocks": [
            {
                "type": "header",
                "content": "104",
                "top_left_x": 48,
                "top_left_y": 28,
                "bottom_right_x": 72,
                "bottom_right_y": 44,
            },
            {
                "type": "header",
                "content": "CHAPTER 4 IMPLEMENTING A GPT MODEL",
                "top_left_x": 250,
                "top_left_y": 27,
                "bottom_right_x": 550,
                "bottom_right_y": 45,
            },
            {
                "type": "text",
                "content": "Body text.",
                "top_left_x": 80,
                "top_left_y": 120,
                "bottom_right_x": 720,
                "bottom_right_y": 150,
            },
            {
                "type": "footer",
                "content": "Publisher footer",
                "top_left_x": 330,
                "top_left_y": 950,
                "bottom_right_x": 470,
                "bottom_right_y": 970,
            },
        ],
    }

    result = page_furniture(page, page_number=126)

    assert result["page"] == 126
    assert [item["align"] for item in result["headers"]] == ["left", "center"]
    assert [item["row"] for item in result["headers"]] == [0, 0]
    assert [item["row_index"] for item in result["headers"]] == [0, 1]
    assert [item["row_size"] for item in result["headers"]] == [2, 2]
    assert result["footers"] == [
        {
            "content": "Publisher footer",
            "align": "center",
            "row": 0,
            "row_index": 0,
            "row_size": 1,
        }
    ]


def test_page_furniture_ignores_blocks_not_present_in_markdown():
    result = page_furniture(
        {
            "index": 0,
            "dimensions": {"width": 800, "height": 1000},
            "markdown": "Visible header\n\nBody",
            "blocks": [
                {
                    "type": "header",
                    "content": "Visible header",
                    "top_left_x": 20,
                    "top_left_y": 20,
                    "bottom_right_x": 180,
                    "bottom_right_y": 40,
                },
                {
                    "type": "footer",
                    "content": "Omitted by OCR markdown",
                    "top_left_x": 300,
                    "top_left_y": 950,
                    "bottom_right_x": 500,
                    "bottom_right_y": 970,
                },
            ],
        },
        page_number=1,
    )

    assert [item["content"] for item in result["headers"]] == ["Visible header"]
    assert result["footers"] == []


def test_document_furniture_applies_page_range_offset():
    response = {
        "pages": [
            {
                "index": 0,
                "dimensions": {"width": 800, "height": 1000},
                "markdown": "12\n\nBody",
                "blocks": [
                    {
                        "type": "header",
                        "content": "12",
                        "top_left_x": 720,
                        "top_left_y": 20,
                        "bottom_right_x": 760,
                        "bottom_right_y": 40,
                    }
                ],
            }
        ]
    }

    result = document_furniture(response, page_number_offset=99)

    assert result["page_count"] == 1
    assert result["pages"][0]["page"] == 100
    assert result["pages"][0]["headers"][0]["align"] == "right"
