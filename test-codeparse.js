'use strict';
const { parseJava } = require('./codeparse');

const sampleJava = `package com.example.banking;

import java.util.List;
import java.util.ArrayList;

public class AccountService {
    private double balance;
    private List<String> transactions;

    public AccountService(double initialBalance) {
        this.balance = initialBalance;
        this.transactions = new ArrayList<>();
    }

    public double calculateInterest(double rate, int years) {
        double result = balance;
        for (int i = 0; i < years; i++) {
            result = result * (1 + rate);
        }
        return result;
    }

    public boolean validateUser(String username, String token) {
        if (username == null || token == null) {
            return false;
        }
        return token.length() > 10 && username.length() > 3;
    }

    public void deposit(double amount) {
        this.balance += amount;
        transactions.add("Deposited: " + amount);
    }

    public double getBalance() {
        return this.balance;
    }
}`;

(async () => {
  console.log(`\nParsing Java file (${sampleJava.split('\n').length} lines)...\n`);
  const units = await parseJava(sampleJava);
  console.log(`Extracted ${units.length} structured units:\n`);
  for (const u of units) {
    console.log(`  [${u.type}] ${u.name}  (lines ${u.startLine}-${u.endLine})`);
  }

  console.log(`\n--- RECALL TEST: developer asks for "calculateInterest" ---`);
  const wanted = units.find(u => u.name === 'calculateInterest');
  if (wanted) {
    console.log(`Found it. Surfacing the actual code lines:\n`);
    console.log(wanted.code);
  } else {
    console.log('Not found');
  }
})();