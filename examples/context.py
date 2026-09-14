#!/usr/bin/env python3
"""Keep retrieved data in Python; print only selected excerpts. No external model calls."""
import json
import subprocess
import sys

def t3(tool, **arguments):
    result = subprocess.run(['t3-mcp-prime', tool, '--stdin'],input=json.dumps(arguments),text=True,capture_output=True,check=True)
    return json.loads(result.stdout)['data']

query = ' '.join(sys.argv[1:]) or 'Prime'
hits = t3('search_messages',query=query,limit=3,snippetChars=300)
for hit in hits['matches']:
    print(json.dumps({k:hit[k] for k in ['threadId','messageId','title','text']},ensure_ascii=False))
# To hydrate only one chosen hit: t3('get_thread',threadId=...,centerMessageId=...,limit=3)
# To ask it a follow-up: receipt = t3('send_message',threadId=...,message=...)
# Only if receipt['accepted']: t3('wait_for_turn',threadId=...,requestId=receipt['requestId'])
